// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BatchStorage} from "./BatchStorage.sol";
import {
    ProductType, StorageType, Status, Origin, Batch, Inspection, Shipment, TempLimit, Cooking
} from "../PorkTypes.sol";

/// @title Traceability registry (Sections 4, 5.2–5.5, 6.1–6.3)
/// @notice Creates batches, records inspections, transformations and two-step custody transfers,
///         derives origin from the inputs and enforces mass balance from carcass to plate.
abstract contract TraceabilityRegistry is BatchStorage {
    event BatchCreated(
        bytes32 indexed batchId,
        ProductType productType,
        address indexed creator,
        uint256 grams,
        uint32 units,
        Origin origin,
        bytes32 docHash
    );
    event BatchInspected(
        bytes32 indexed batchId, address indexed veterinarian, bool passed, bool trichinellaNegative, bytes32 reportHash
    );
    event BatchTransformed(
        address indexed operator,
        bytes32[] inputs,
        uint256[] gramsUsed,
        bytes32[] outputs,
        uint256[] outputGrams,
        ProductType outputType
    );
    event BatchShipped(
        bytes32 indexed batchId, address indexed from, address indexed to, address carrier, uint256 grams, bytes32 docHash
    );
    event BatchReceived(
        bytes32 indexed batchId,
        address indexed from,
        address indexed to,
        uint256 acceptedGrams,
        int16 receiptTemp,
        bool accepted
    );
    event CookingRecorded(bytes32 indexed servingLotId, int16 coreTemp, bool meetsMinimum, bytes32 logHash);
    event SalesRecorded(bytes32 indexed servingLotId, uint32 portions, uint32 totalSold);

    error InvalidQuantity();
    error InvalidTime();
    error LengthMismatch();
    error InvalidInputCount();
    error InvalidOutputCount();
    error DuplicateInput(bytes32 batchId);
    error TransitionNotAllowed(ProductType from, ProductType to);
    error MassBalanceViolated(uint256 gramsIn, uint256 gramsOut);
    error SelfInspectionNotAllowed(bytes32 batchId);
    error InvalidRecipient(address recipient);
    error InvalidCarrier(address carrier);
    error NotRecipient(bytes32 batchId, address caller);
    error ReceiptTemperatureAboveLimit(int16 receiptTemp, int16 limit);
    error NotServingLot(bytes32 batchId);
    error CookingAlreadyRecorded(bytes32 servingLotId);
    error PortionsExceeded(uint32 produced, uint32 requestedTotal);

    // ------------------------------------------------------- 1. slaughter

    /// @notice Creates a carcass batch. The country of slaughter is taken from the caller's
    ///         registration, never passed as a parameter. Animal identifiers and the movement
    ///         documents are covered by `docHash`.
    function createCarcassBatch(
        bytes32 batchId,
        bytes2 countryOfBirth,
        bytes2 countryOfRearing,
        uint256 grams,
        uint64 slaughterTime,
        bytes32 docHash
    ) external onlyRole(SLAUGHTERHOUSE_ROLE) {
        if (countryOfBirth == bytes2(0) || countryOfRearing == bytes2(0)) revert InvalidCountry();
        if (grams == 0) revert InvalidQuantity();
        if (slaughterTime == 0 || slaughterTime > block.timestamp) revert InvalidTime();

        Batch storage b = _newBatch(batchId);
        b.productType = ProductType.CARCASS;
        b.storageType = StorageType.CHILLED;
        b.status = Status.PENDING_INSPECTION;
        b.slaughterTime = slaughterTime;
        b.custodian = msg.sender;
        b.creator = msg.sender;
        b.quantity = grams;
        b.remaining = grams;
        b.origin = Origin({
            countryOfBirth: countryOfBirth,
            countryOfRearing: countryOfRearing,
            countryOfSlaughter: _orgs[msg.sender].country
        });
        b.docHash = docHash;

        emit BatchCreated(batchId, ProductType.CARCASS, msg.sender, grams, 0, b.origin, docHash);
    }

    // ------------------------------------------------------ 2. inspection

    /// @notice The official veterinarian releases (or rejects) a carcass batch. The veterinarian
    ///         must be a different signer from the slaughterhouse that created the batch.
    function recordInspection(bytes32 batchId, bool passed, bool trichinellaNegative, bytes32 reportHash)
        external
        onlyRole(VETERINARIAN_ROLE)
    {
        Batch storage b = _existing(batchId);
        if (b.status != Status.PENDING_INSPECTION) revert InvalidStatus(batchId, b.status);
        if (msg.sender == b.creator) revert SelfInspectionNotAllowed(batchId);

        _inspections[batchId] = Inspection({
            veterinarian: msg.sender,
            inspectedAt: uint64(block.timestamp),
            passed: passed,
            trichinellaNegative: trichinellaNegative,
            reportHash: reportHash
        });
        _setStatus(batchId, b, passed && trichinellaNegative ? Status.ACTIVE : Status.REJECTED);
        emit BatchInspected(batchId, msg.sender, passed, trichinellaNegative, reportHash);
    }

    // ------------------------------------------- 4, 5, 9. transformations

    /// @notice Consumes (part of) the input batches and creates output batches.
    ///         CUTTING_PLANT: CARCASS → PRIMAL_CUT; PROCESSOR: PRIMAL_CUT → GYROS_CONE | SKEWER;
    ///         RETAILER: GYROS_CONE | SKEWER → SERVING_LOT (units = portions produced).
    ///         The meat in the outputs never exceeds the meat consumed, and the origin of the
    ///         outputs is derived from the inputs ("XX" where they disagree).
    /// @param units        Count per output (skewers, portions); required for SKEWER and SERVING_LOT.
    /// @param storageType  Storage regime of the outputs; selects their temperature limit.
    /// @param useBy        Use-by date of the outputs; may not exceed the earliest use-by of the inputs.
    /// @param docHash      Hash of the cutting record, product specification or HACCP record.
    function transform(
        bytes32[] calldata inputs,
        uint256[] calldata gramsUsed,
        bytes32[] calldata outputs,
        uint256[] calldata outputGrams,
        ProductType outputType,
        uint32[] calldata units,
        StorageType storageType,
        uint64 useBy,
        bytes32 docHash
    ) external {
        if (inputs.length == 0 || inputs.length > MAX_INPUTS) revert InvalidInputCount();
        if (outputs.length == 0 || outputs.length > MAX_OUTPUTS) revert InvalidOutputCount();
        if (gramsUsed.length != inputs.length || outputGrams.length != outputs.length || units.length != outputs.length)
        {
            revert LengthMismatch();
        }

        (uint256 gramsIn, Origin memory origin, uint64 slaughterTime, uint64 maxUseBy) =
            _consumeInputs(inputs, gramsUsed, outputType);

        if (useBy <= block.timestamp || (maxUseBy != 0 && useBy > maxUseBy)) revert InvalidTime();

        uint256 gramsOut;
        bool needsUnits = outputType == ProductType.SKEWER || outputType == ProductType.SERVING_LOT;
        for (uint256 i; i < outputs.length; ++i) {
            if (outputGrams[i] == 0 || (needsUnits && units[i] == 0)) revert InvalidQuantity();
            gramsOut += outputGrams[i];

            Batch storage o = _newBatch(outputs[i]);
            o.productType = outputType;
            o.storageType = storageType;
            o.status = Status.ACTIVE;
            o.units = units[i];
            o.useBy = useBy;
            o.slaughterTime = slaughterTime;
            o.custodian = msg.sender;
            o.creator = msg.sender;
            o.quantity = outputGrams[i];
            o.remaining = outputGrams[i];
            o.origin = origin;
            o.docHash = docHash;
            o.parents = inputs;

            emit BatchCreated(outputs[i], outputType, msg.sender, outputGrams[i], units[i], origin, docHash);
        }
        if (gramsOut > gramsIn) revert MassBalanceViolated(gramsIn, gramsOut);

        emit BatchTransformed(msg.sender, inputs, gramsUsed, outputs, outputGrams, outputType);
    }

    // ------------------------------------------------ 6, 7. shipment, receipt

    /// @notice First step of the two-step handover. Custody stays with the sender until receipt.
    function ship(bytes32 batchId, address recipient, address carrier, bytes32 docHash) external {
        Batch storage b = _existing(batchId);
        _requireUsable(batchId, b);
        if (b.productType == ProductType.SERVING_LOT) revert InvalidStatus(batchId, b.status);
        if (recipient == msg.sender || !_orgs[recipient].registered) revert InvalidRecipient(recipient);
        if (!hasRole(CARRIER_ROLE, carrier)) revert InvalidCarrier(carrier);

        _shipments[batchId] = Shipment({
            sender: msg.sender,
            recipient: recipient,
            carrier: carrier,
            shippedAt: uint64(block.timestamp),
            docHash: docHash,
            active: true
        });
        _setStatus(batchId, b, Status.IN_TRANSIT);
        emit BatchShipped(batchId, msg.sender, recipient, carrier, b.remaining, docHash);
    }

    /// @notice Second step of the handover, signed by the named recipient. (Named `receiveBatch`
    ///         because `receive` is reserved in Solidity.)
    ///         Accepted: custody passes and the remaining quantity becomes the accepted quantity.
    ///         Rejected: the batch returns to the sender. A batch quarantined (or recalled) in
    ///         transit is received as usual but keeps that status.
    function receiveBatch(bytes32 batchId, uint256 acceptedGrams, int16 receiptTemp, bool accepted) external {
        Batch storage b = _existing(batchId);
        Shipment storage s = _shipments[batchId];
        if (!s.active || s.recipient != msg.sender) revert NotRecipient(batchId, msg.sender);

        if (accepted) {
            if (acceptedGrams == 0 || acceptedGrams > b.remaining) revert InvalidQuantity();
            TempLimit memory lim = _limits[b.productType][b.storageType];
            if (lim.set && receiptTemp > lim.maxTemp) revert ReceiptTemperatureAboveLimit(receiptTemp, lim.maxTemp);
            b.remaining = acceptedGrams;
            b.custodian = msg.sender;
        } else if (acceptedGrams != 0) {
            revert InvalidQuantity();
        }
        s.active = false;

        if (b.status == Status.IN_TRANSIT) {
            _setStatus(batchId, b, Status.ACTIVE);
        } else if (b.status == Status.QUARANTINED) {
            b.statusBeforeQuarantine = Status.ACTIVE;
        }
        emit BatchReceived(batchId, s.sender, msg.sender, acceptedGrams, receiptTemp, accepted);
    }

    // ---------------------------------------------- 9, 10. cooking and sale

    /// @notice Records the cooking core temperature of a serving lot once; it cannot be overwritten.
    function recordCooking(bytes32 servingLotId, int16 coreTemp, bytes32 logHash) external onlyRole(RETAILER_ROLE) {
        Batch storage b = _existing(servingLotId);
        if (b.productType != ProductType.SERVING_LOT) revert NotServingLot(servingLotId);
        if (b.custodian != msg.sender) revert NotCustodian(servingLotId, msg.sender);
        Cooking storage c = _cooking[servingLotId];
        if (c.recorded) revert CookingAlreadyRecorded(servingLotId);

        bool ok = coreTemp >= minCookingTemp;
        _cooking[servingLotId] = Cooking({
            coreTemp: coreTemp,
            recorded: true,
            meetsMinimum: ok,
            recordedAt: uint64(block.timestamp),
            logHash: logHash
        });
        emit CookingRecorded(servingLotId, coreTemp, ok, logHash);
    }

    /// @notice Aggregated portions sold from a serving lot (no customer data). The running total
    ///         can never exceed the portions produced, which closes the mass balance.
    function recordSales(bytes32 servingLotId, uint32 portions) external onlyRole(RETAILER_ROLE) {
        Batch storage b = _existing(servingLotId);
        if (b.productType != ProductType.SERVING_LOT) revert NotServingLot(servingLotId);
        _requireUsable(servingLotId, b);
        if (portions == 0) revert InvalidQuantity();

        uint32 total = _portionsSold[servingLotId] + portions;
        if (total > b.units) revert PortionsExceeded(b.units, total);
        _portionsSold[servingLotId] = total;
        emit SalesRecorded(servingLotId, portions, total);

        if (total == b.units) _setStatus(servingLotId, b, Status.CONSUMED);
    }

    // --------------------------------------------------------------- internal

    function _newBatch(bytes32 batchId) private returns (Batch storage b) {
        if (batchId == bytes32(0)) revert InvalidBatchId();
        b = _batches[batchId];
        if (b.createdAt != 0) revert BatchAlreadyExists(batchId);
        b.createdAt = uint64(block.timestamp);
    }

    function _consumeInputs(bytes32[] calldata inputs, uint256[] calldata gramsUsed, ProductType outputType)
        private
        returns (uint256 gramsIn, Origin memory origin, uint64 slaughterTime, uint64 minUseBy)
    {
        for (uint256 i; i < inputs.length; ++i) {
            bytes32 id = inputs[i];
            for (uint256 j; j < i; ++j) {
                if (inputs[j] == id) revert DuplicateInput(id);
            }
            Batch storage b = _existing(id);
            _requireUsable(id, b);
            _checkTransition(b.productType, outputType);

            uint256 used = gramsUsed[i];
            if (used == 0 || used > b.remaining) revert InvalidQuantity();
            b.remaining -= used;
            gramsIn += used;
            if (b.remaining == 0) _setStatus(id, b, Status.CONSUMED);

            if (i == 0) {
                origin = b.origin;
                slaughterTime = b.slaughterTime;
            } else {
                if (origin.countryOfBirth != b.origin.countryOfBirth) origin.countryOfBirth = MIXED;
                if (origin.countryOfRearing != b.origin.countryOfRearing) origin.countryOfRearing = MIXED;
                if (origin.countryOfSlaughter != b.origin.countryOfSlaughter) origin.countryOfSlaughter = MIXED;
                if (b.slaughterTime < slaughterTime) slaughterTime = b.slaughterTime;
            }
            if (b.useBy != 0 && (minUseBy == 0 || b.useBy < minUseBy)) minUseBy = b.useBy;
        }
    }

    /// @dev Each role may perform only its own product transition (Section 6.1).
    function _checkTransition(ProductType from, ProductType to) private view {
        bytes32 role;
        if (from == ProductType.CARCASS && to == ProductType.PRIMAL_CUT) {
            role = CUTTING_PLANT_ROLE;
        } else if (from == ProductType.PRIMAL_CUT && (to == ProductType.GYROS_CONE || to == ProductType.SKEWER)) {
            role = PROCESSOR_ROLE;
        } else if ((from == ProductType.GYROS_CONE || from == ProductType.SKEWER) && to == ProductType.SERVING_LOT) {
            role = RETAILER_ROLE;
        } else {
            revert TransitionNotAllowed(from, to);
        }
        _checkRole(role);
    }
}
