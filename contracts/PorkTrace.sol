// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PorkTrace — simplified restaurant-and-customer model
/// @notice The souvlaki restaurant records what it knows about each delivery of gyros cones and
///         skewers; the customer reads the records of the serving lot on their receipt through a QR
///         code. The contract derives the origin of every serving lot from the delivery records,
///         computes the portions from the meat used, checks storage and cooking temperatures and
///         flags withdrawn batches. Nothing is ever deleted or overwritten; only status fields and
///         running totals change.
///         Temperatures are int16 in tenths of a degree Celsius (4 °C = 40, −18 °C = −180).
contract PorkTrace is AccessControl {
    // ================================================================ types

    enum ProductType {
        GYROS_CONE,
        SKEWER
    }

    enum StorageType {
        CHILLED,
        FROZEN
    }

    enum BatchStatus {
        IN_STOCK,
        DEPLETED,
        WITHDRAWN
    }

    enum ReasonCode {
        SUPPLIER_RECALL,
        TEMPERATURE,
        QUALITY,
        OTHER
    }

    /// @notice ISO 3166-1 alpha-2 codes; "XX" when the batches of a lot disagree.
    struct Origin {
        bytes2 countryOfBirth;
        bytes2 countryOfRearing;
        bytes2 countryOfSlaughter;
    }

    /// @notice Delivery batch.
    struct Batch {
        ProductType productType;
        StorageType storageType;
        BatchStatus status;
        uint8 storageUnit;
        int16 receiptTemp;
        int16 maxStorageTemp; // highest temperature recorded while in stock (starts at the receipt temperature)
        uint32 grams;
        uint32 gramsRemaining;
        uint64 slaughterDate;
        uint64 useByDate;
        uint64 receivedAt;
        Origin origin;
        bytes32 docHash; // SHA-256 of the delivery note and a photo of the label
        string supplierName;
        string supplierBatchCode;
        string slaughterhouseApproval;
    }

    /// @notice Input of registerBatch (grouped to keep the call readable).
    struct BatchInput {
        bytes32 batchId;
        ProductType productType;
        StorageType storageType;
        string supplierName;
        string supplierBatchCode;
        Origin origin;
        string slaughterhouseApproval;
        uint64 slaughterDate;
        uint64 useByDate;
        uint32 grams;
        int16 receiptTemp;
        uint8 storageUnit;
        bytes32 docHash;
    }

    /// @notice Storage report.
    struct StorageReport {
        uint8 storageUnit;
        uint64 windowStart;
        uint64 windowEnd;
        int16 minTemp;
        int16 maxTemp;
        int16 meanTemp;
        uint16 minutesAbove;
        bytes32 seriesHash;
        bool breach;
    }

    /// @notice Serving lot.
    struct Lot {
        uint64 openedAt;
        bytes32[] batchIds;
        uint32[] gramsUsed;
        uint16 gramsPerPortion;
        uint32 portionsProduced;
        Origin origin;
        int16 coreTemp;
        bool cookingRecorded;
        bytes32 cookingLogHash;
        uint32 portionsSold;
        bool closed;
    }

    struct Withdrawal {
        ReasonCode reasonCode;
        bytes32 noticeHash;
        uint64 withdrawnAt;
        address withdrawnBy; // the owner, or the sensor whose report triggered an automatic withdrawal
    }

    /// @notice Everything the customer's verification page needs, in one call.
    struct LotSummary {
        Origin origin;
        bytes2 singleCountry; // set only when birth, rearing and slaughter are the same country for every batch
        bytes32[] batchIds;
        uint64 openedAt;
        uint64 oldestSlaughterDate;
        uint32 daysSinceSlaughter; // from the oldest slaughter date to the lot's opening
        bool storageWithinLimit;
        bool cookingRecorded;
        int16 coreTemp;
        bool cookingMeetsMinimum;
        bool anyWithdrawn;
        uint32 portionsProduced;
        uint32 portionsSold;
        bool closed;
    }

    // ============================================================ constants

    bytes32 public constant OWNER_ROLE = DEFAULT_ADMIN_ROLE;
    bytes32 public constant STAFF_ROLE = keccak256("STAFF");
    bytes32 public constant SENSOR_ROLE = keccak256("SENSOR");

    bytes2 public constant MIXED = "XX";
    uint256 public constant MAX_BATCHES_PER_LOT = 16;

    // ======================================= parameters set at deployment

    int16 public immutable chilledLimit;
    int16 public immutable frozenLimit;
    int16 public immutable minCookingTemp;
    uint16 public immutable toleranceMinutes;

    // ============================================================== storage

    mapping(bytes32 => Batch) private _batches;
    mapping(bytes32 => Lot) private _lots;
    mapping(bytes32 => Withdrawal) private _withdrawals;
    mapping(address => uint8) public sensorUnit;
    mapping(uint8 => uint64) public lastWindowEnd;
    mapping(uint8 => StorageReport[]) private _reports;
    mapping(uint8 => bytes32[]) private _unitStock; // batches in stock per storage unit
    mapping(bytes32 => uint256) private _stockIndex; // position + 1 in _unitStock

    // =============================================================== events

    event BatchRegistered(
        bytes32 indexed batchId,
        ProductType productType,
        StorageType storageType,
        Origin origin,
        uint32 grams,
        int16 receiptTemp,
        uint8 storageUnit,
        bytes32 docHash
    );
    event StorageReported(
        uint8 indexed storageUnit,
        uint64 windowStart,
        uint64 windowEnd,
        int16 minTemp,
        int16 maxTemp,
        int16 meanTemp,
        uint16 minutesAbove,
        bytes32 seriesHash,
        bool breach
    );
    event BatchDepleted(bytes32 indexed batchId);
    event BatchWithdrawn(bytes32 indexed batchId, ReasonCode reasonCode, bytes32 noticeHash, address indexed by);
    event LotOpened(
        bytes32 indexed lotId, bytes32[] batchIds, uint32[] gramsUsed, uint16 gramsPerPortion, uint32 portionsProduced, Origin origin
    );
    event CookingRecorded(bytes32 indexed lotId, int16 coreTemp, bool meetsMinimum, bytes32 cookingLogHash);
    event SalesRecorded(bytes32 indexed lotId, uint32 portions, uint32 portionsSold, uint64 periodEnd);
    event LotClosed(bytes32 indexed lotId, uint32 portionsSold);
    event SensorAdded(address indexed account, uint8 storageUnit);

    // =============================================================== errors

    error ZeroAddress();
    error InvalidId();
    error AlreadyExists(bytes32 id);
    error BatchNotFound(bytes32 batchId);
    error LotNotFound(bytes32 lotId);
    error InvalidCountry();
    error InvalidQuantity();
    error SlaughterDateInFuture();
    error UseByPassed(bytes32 batchId);
    error ReceiptTemperatureAboveLimit(int16 receiptTemp, int16 limit);
    error SensorAlreadyBound(address account);
    error WrongStorageUnit(address sensor, uint8 unit);
    error InvalidWindow();
    error InvalidTemperatureSummary();
    error LengthMismatch();
    error InvalidBatchCount();
    error DuplicateBatch(bytes32 batchId);
    error BatchNotInStock(bytes32 batchId, BatchStatus status);
    error InsufficientGrams(bytes32 batchId, uint32 remaining, uint32 requested);
    error NoPortions();
    error LotNotOpen(bytes32 lotId);
    error CookingAlreadyRecorded(bytes32 lotId);
    error PortionsExceeded(uint32 produced, uint32 requestedTotal);
    error AlreadyWithdrawn(bytes32 batchId);

    // ========================================================== constructor

    /// @param owner              Restaurant owner (OWNER role).
    /// @param chilledLimit_      Max storage temperature for chilled products, e.g. 40 (4 °C).
    /// @param frozenLimit_       Max storage temperature for frozen products, e.g. −180 (−18 °C).
    /// @param minCookingTemp_    Minimum cooking core temperature from the HACCP plan, e.g. 750 (75 °C).
    /// @param toleranceMinutes_  Minutes above the limit tolerated per reporting window.
    constructor(address owner, int16 chilledLimit_, int16 frozenLimit_, int16 minCookingTemp_, uint16 toleranceMinutes_) {
        if (owner == address(0)) revert ZeroAddress();
        _grantRole(OWNER_ROLE, owner);
        chilledLimit = chilledLimit_;
        frozenLimit = frozenLimit_;
        minCookingTemp = minCookingTemp_;
        toleranceMinutes = toleranceMinutes_;
    }

    // ================================================================ OWNER

    function addStaff(address account) external onlyRole(OWNER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _grantRole(STAFF_ROLE, account);
    }

    /// @notice Binds a sensor account to one refrigerator or freezer.
    function addSensor(address account, uint8 unit) external onlyRole(OWNER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (hasRole(SENSOR_ROLE, account)) revert SensorAlreadyBound(account);
        sensorUnit[account] = unit;
        _grantRole(SENSOR_ROLE, account);
        emit SensorAdded(account, unit);
    }

    /// @notice Withdraws a batch (supplier recall, quality problem, …). Every lot made from it shows a warning.
    function withdrawBatch(bytes32 batchId, ReasonCode reasonCode, bytes32 noticeHash) external onlyRole(OWNER_ROLE) {
        Batch storage b = _batch(batchId);
        if (b.status == BatchStatus.WITHDRAWN) revert AlreadyWithdrawn(batchId);
        _withdraw(batchId, b, reasonCode, noticeHash);
    }

    // ================================================================ STAFF

    /// @notice Records a delivery on receipt. Rejects an expired batch or one received above the limit.
    function registerBatch(BatchInput calldata d) external onlyRole(STAFF_ROLE) {
        if (d.batchId == bytes32(0)) revert InvalidId();
        Batch storage b = _batches[d.batchId];
        if (b.receivedAt != 0) revert AlreadyExists(d.batchId);
        if (
            d.origin.countryOfBirth == bytes2(0) || d.origin.countryOfRearing == bytes2(0)
                || d.origin.countryOfSlaughter == bytes2(0)
        ) revert InvalidCountry();
        if (d.grams == 0) revert InvalidQuantity();
        if (d.slaughterDate > block.timestamp) revert SlaughterDateInFuture();
        if (d.useByDate <= block.timestamp) revert UseByPassed(d.batchId);
        int16 limit = limitFor(d.storageType);
        if (d.receiptTemp > limit) revert ReceiptTemperatureAboveLimit(d.receiptTemp, limit);

        b.productType = d.productType;
        b.storageType = d.storageType;
        b.status = BatchStatus.IN_STOCK;
        b.storageUnit = d.storageUnit;
        b.receiptTemp = d.receiptTemp;
        b.maxStorageTemp = d.receiptTemp;
        b.grams = d.grams;
        b.gramsRemaining = d.grams;
        b.slaughterDate = d.slaughterDate;
        b.useByDate = d.useByDate;
        b.receivedAt = uint64(block.timestamp);
        b.origin = d.origin;
        b.docHash = d.docHash;
        b.supplierName = d.supplierName;
        b.supplierBatchCode = d.supplierBatchCode;
        b.slaughterhouseApproval = d.slaughterhouseApproval;

        _unitStock[d.storageUnit].push(d.batchId);
        _stockIndex[d.batchId] = _unitStock[d.storageUnit].length;

        emit BatchRegistered(
            d.batchId, d.productType, d.storageType, d.origin, d.grams, d.receiptTemp, d.storageUnit, d.docHash
        );
    }

    /// @notice Opens the serving lot of a shift. Portions and origin are computed by the contract.
    function openLot(bytes32 lotId, bytes32[] calldata batchIds, uint32[] calldata gramsUsed, uint16 gramsPerPortion)
        external
        onlyRole(STAFF_ROLE)
    {
        if (lotId == bytes32(0)) revert InvalidId();
        Lot storage lot = _lots[lotId];
        if (lot.openedAt != 0) revert AlreadyExists(lotId);
        if (batchIds.length == 0 || batchIds.length > MAX_BATCHES_PER_LOT) revert InvalidBatchCount();
        if (gramsUsed.length != batchIds.length) revert LengthMismatch();
        if (gramsPerPortion == 0) revert InvalidQuantity();

        uint256 total;
        Origin memory origin;
        for (uint256 i; i < batchIds.length; ++i) {
            bytes32 id = batchIds[i];
            for (uint256 j; j < i; ++j) {
                if (batchIds[j] == id) revert DuplicateBatch(id);
            }
            Batch storage b = _batch(id);
            if (b.status != BatchStatus.IN_STOCK) revert BatchNotInStock(id, b.status);
            if (block.timestamp > b.useByDate) revert UseByPassed(id);
            uint32 g = gramsUsed[i];
            if (g == 0) revert InvalidQuantity();
            if (g > b.gramsRemaining) revert InsufficientGrams(id, b.gramsRemaining, g);

            b.gramsRemaining -= g;
            total += g;
            if (b.gramsRemaining == 0) {
                b.status = BatchStatus.DEPLETED;
                _removeFromStock(id, b.storageUnit);
                emit BatchDepleted(id);
            }

            if (i == 0) {
                origin = b.origin;
            } else {
                if (origin.countryOfBirth != b.origin.countryOfBirth) origin.countryOfBirth = MIXED;
                if (origin.countryOfRearing != b.origin.countryOfRearing) origin.countryOfRearing = MIXED;
                if (origin.countryOfSlaughter != b.origin.countryOfSlaughter) origin.countryOfSlaughter = MIXED;
            }
        }

        uint256 portions = total / gramsPerPortion;
        if (portions == 0) revert NoPortions();

        lot.openedAt = uint64(block.timestamp);
        lot.batchIds = batchIds;
        lot.gramsUsed = gramsUsed;
        lot.gramsPerPortion = gramsPerPortion;
        lot.portionsProduced = uint32(portions);
        lot.origin = origin;

        emit LotOpened(lotId, batchIds, gramsUsed, gramsPerPortion, uint32(portions), origin);
    }

    /// @notice Cooking core temperature measured at the grill; recorded once per lot.
    function recordCooking(bytes32 lotId, int16 coreTemp, bytes32 cookingLogHash) external onlyRole(STAFF_ROLE) {
        Lot storage lot = _openLot(lotId);
        if (lot.cookingRecorded) revert CookingAlreadyRecorded(lotId);
        lot.coreTemp = coreTemp;
        lot.cookingRecorded = true;
        lot.cookingLogHash = cookingLogHash;
        emit CookingRecorded(lotId, coreTemp, coreTemp >= minCookingTemp, cookingLogHash);
    }

    /// @notice Aggregated sales from the POS; the running total never exceeds the portions produced.
    function recordSales(bytes32 lotId, uint32 portions) external onlyRole(STAFF_ROLE) {
        Lot storage lot = _openLot(lotId);
        if (portions == 0) revert InvalidQuantity();
        uint32 total = lot.portionsSold + portions;
        if (total > lot.portionsProduced) revert PortionsExceeded(lot.portionsProduced, total);
        lot.portionsSold = total;
        emit SalesRecorded(lotId, portions, total, uint64(block.timestamp));
    }

    function closeLot(bytes32 lotId) external onlyRole(STAFF_ROLE) {
        Lot storage lot = _openLot(lotId);
        lot.closed = true;
        emit LotClosed(lotId, lot.portionsSold);
    }

    // =============================================================== SENSOR

    /// @notice Summary of one reporting window from the sensor of `unit`. If the minutes above the
    ///         limit exceed the tolerance, every batch in stock in that unit is withdrawn.
    function reportStorage(
        uint8 unit,
        uint64 windowStart,
        uint64 windowEnd,
        int16 minTemp,
        int16 maxTemp,
        int16 meanTemp,
        uint16 minutesAbove,
        bytes32 seriesHash
    ) external onlyRole(SENSOR_ROLE) {
        if (sensorUnit[msg.sender] != unit) revert WrongStorageUnit(msg.sender, unit);
        if (windowStart >= windowEnd || windowEnd > block.timestamp || windowStart < lastWindowEnd[unit]) {
            revert InvalidWindow();
        }
        if (minTemp > meanTemp || meanTemp > maxTemp) revert InvalidTemperatureSummary();

        lastWindowEnd[unit] = windowEnd;
        bool breach = minutesAbove > toleranceMinutes;
        _reports[unit].push(
            StorageReport(unit, windowStart, windowEnd, minTemp, maxTemp, meanTemp, minutesAbove, seriesHash, breach)
        );
        emit StorageReported(unit, windowStart, windowEnd, minTemp, maxTemp, meanTemp, minutesAbove, seriesHash, breach);

        bytes32[] storage stock = _unitStock[unit];
        for (uint256 i; i < stock.length; ++i) {
            Batch storage b = _batches[stock[i]];
            if (maxTemp > b.maxStorageTemp) b.maxStorageTemp = maxTemp;
        }
        if (breach) {
            // _withdraw removes the batch from `stock`, so always take the last one
            while (stock.length > 0) {
                bytes32 id = stock[stock.length - 1];
                _withdraw(id, _batches[id], ReasonCode.TEMPERATURE, seriesHash);
            }
        }
    }

    // ================================================================ views

    function limitFor(StorageType storageType) public view returns (int16) {
        return storageType == StorageType.CHILLED ? chilledLimit : frozenLimit;
    }

    function getBatch(bytes32 batchId) external view returns (Batch memory) {
        return _batch(batchId);
    }

    function getLot(bytes32 lotId) external view returns (Lot memory) {
        return _lot(lotId);
    }

    function getWithdrawal(bytes32 batchId) external view returns (Withdrawal memory) {
        return _withdrawals[batchId];
    }

    function getStorageReports(uint8 unit) external view returns (StorageReport[] memory) {
        return _reports[unit];
    }

    function stockOf(uint8 unit) external view returns (bytes32[] memory) {
        return _unitStock[unit];
    }

    function getLotSummary(bytes32 lotId) external view returns (LotSummary memory s) {
        Lot storage lot = _lot(lotId);
        s.origin = lot.origin;
        s.batchIds = lot.batchIds;
        s.openedAt = lot.openedAt;
        s.storageWithinLimit = true;
        s.cookingRecorded = lot.cookingRecorded;
        s.coreTemp = lot.coreTemp;
        s.cookingMeetsMinimum = lot.cookingRecorded && lot.coreTemp >= minCookingTemp;
        s.portionsProduced = lot.portionsProduced;
        s.portionsSold = lot.portionsSold;
        s.closed = lot.closed;

        Origin memory o = lot.origin;
        if (o.countryOfBirth == o.countryOfRearing && o.countryOfRearing == o.countryOfSlaughter && o.countryOfBirth != MIXED) {
            s.singleCountry = o.countryOfBirth;
        }

        for (uint256 i; i < lot.batchIds.length; ++i) {
            Batch storage b = _batches[lot.batchIds[i]];
            if (i == 0 || b.slaughterDate < s.oldestSlaughterDate) s.oldestSlaughterDate = b.slaughterDate;
            if (b.maxStorageTemp > limitFor(b.storageType)) s.storageWithinLimit = false;
            if (b.status == BatchStatus.WITHDRAWN) s.anyWithdrawn = true;
        }
        s.daysSinceSlaughter = uint32((lot.openedAt - s.oldestSlaughterDate) / 1 days);
    }

    // ============================================================= internal

    function _batch(bytes32 batchId) private view returns (Batch storage b) {
        b = _batches[batchId];
        if (b.receivedAt == 0) revert BatchNotFound(batchId);
    }

    function _lot(bytes32 lotId) private view returns (Lot storage lot) {
        lot = _lots[lotId];
        if (lot.openedAt == 0) revert LotNotFound(lotId);
    }

    function _openLot(bytes32 lotId) private view returns (Lot storage lot) {
        lot = _lot(lotId);
        if (lot.closed) revert LotNotOpen(lotId);
    }

    function _withdraw(bytes32 batchId, Batch storage b, ReasonCode reasonCode, bytes32 noticeHash) private {
        if (b.status == BatchStatus.IN_STOCK) _removeFromStock(batchId, b.storageUnit);
        b.status = BatchStatus.WITHDRAWN;
        _withdrawals[batchId] = Withdrawal(reasonCode, noticeHash, uint64(block.timestamp), msg.sender);
        emit BatchWithdrawn(batchId, reasonCode, noticeHash, msg.sender);
    }

    function _removeFromStock(bytes32 batchId, uint8 unit) private {
        bytes32[] storage stock = _unitStock[unit];
        uint256 idx = _stockIndex[batchId] - 1;
        uint256 last = stock.length - 1;
        if (idx != last) {
            bytes32 moved = stock[last];
            stock[idx] = moved;
            _stockIndex[moved] = idx + 1;
        }
        stock.pop();
        delete _stockIndex[batchId];
    }
}
