// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessRegistry} from "./AccessRegistry.sol";
import {
    ProductType,
    StorageType,
    Status,
    Origin,
    Batch,
    Inspection,
    Shipment,
    ColdChainSummary,
    TempLimit,
    Cooking,
    Recall
} from "../PorkTypes.sol";

/// @title Shared state of the four modules
/// @notice Holds the batch graph and the per-batch records written by the other modules,
///         plus the helpers they share (status changes, quarantine, ancestry walk).
abstract contract BatchStorage is AccessRegistry {
    /// @notice Inputs per transformation are capped so the ancestry walk in isRecalled() stays bounded.
    uint256 public constant MAX_INPUTS = 16;
    uint256 public constant MAX_OUTPUTS = 64;
    uint256 public constant MAX_BATCHES_PER_REPORT = 64;
    /// @notice Origin value used when the inputs disagree on a country.
    bytes2 public constant MIXED = "XX";

    mapping(bytes32 => Batch) internal _batches;
    mapping(bytes32 => Inspection) internal _inspections;
    mapping(bytes32 => Shipment) internal _shipments;
    mapping(bytes32 => ColdChainSummary) internal _coldChain;
    mapping(bytes32 => Cooking) internal _cooking;
    mapping(bytes32 => uint32) internal _portionsSold;
    mapping(bytes32 => Recall) internal _recalls;
    mapping(ProductType => mapping(StorageType => TempLimit)) internal _limits;
    int16 public minCookingTemp;

    event BatchStatusChanged(bytes32 indexed batchId, Status from, Status to);
    event BatchQuarantined(bytes32 indexed batchId, int16 recordedTemp, int16 limit);

    error BatchNotFound(bytes32 batchId);
    error BatchAlreadyExists(bytes32 batchId);
    error InvalidBatchId();
    error InvalidStatus(bytes32 batchId, Status status);
    error NotCustodian(bytes32 batchId, address caller);
    error BatchIsRecalled(bytes32 batchId);
    error BatchExpired(bytes32 batchId);

    // ------------------------------------------------------------------ views

    function getBatch(bytes32 batchId) external view returns (Batch memory) {
        return _existing(batchId);
    }

    function originOf(bytes32 batchId) external view returns (Origin memory) {
        return _existing(batchId).origin;
    }

    /// @notice True if the batch or any of its ancestors has been recalled.
    function isRecalled(bytes32 batchId) public view returns (bool) {
        _existing(batchId);
        return _isRecalled(batchId);
    }

    /// @notice Status as the consumer should see it: RECALLED if any ancestor is recalled.
    function effectiveStatus(bytes32 batchId) external view returns (Status) {
        Batch storage b = _existing(batchId);
        return _isRecalled(batchId) ? Status.RECALLED : b.status;
    }

    /// @notice True if a temperature breach was recorded on the batch or any of its ancestors.
    function hasBreachInAncestry(bytes32 batchId) public view returns (bool) {
        _existing(batchId);
        return _hasBreach(batchId);
    }

    /// @notice Every ancestor of a batch (without duplicates), nearest first. Walking back gives provenance.
    function getProvenance(bytes32 batchId) external view returns (bytes32[] memory ancestors) {
        _existing(batchId);
        ancestors = new bytes32[](_countAncestors(batchId));
        uint256 n;
        uint256 head;
        // breadth-first walk; `ancestors` doubles as the queue
        bytes32[] storage first = _batches[batchId].parents;
        for (uint256 i; i < first.length; ++i) {
            n = _pushUnique(ancestors, n, first[i]);
        }
        while (head < n) {
            bytes32[] storage ps = _batches[ancestors[head++]].parents;
            for (uint256 i; i < ps.length; ++i) {
                n = _pushUnique(ancestors, n, ps[i]);
            }
        }
        assembly ("memory-safe") {
            mstore(ancestors, n)
        }
    }

    function getInspection(bytes32 batchId) external view returns (Inspection memory) {
        return _inspections[batchId];
    }

    function getShipment(bytes32 batchId) external view returns (Shipment memory) {
        return _shipments[batchId];
    }

    function getColdChain(bytes32 batchId) external view returns (ColdChainSummary memory) {
        return _coldChain[batchId];
    }

    function getCooking(bytes32 servingLotId) external view returns (Cooking memory) {
        return _cooking[servingLotId];
    }

    function portionsSold(bytes32 servingLotId) external view returns (uint32) {
        return _portionsSold[servingLotId];
    }

    function getRecall(bytes32 batchId) external view returns (Recall memory) {
        return _recalls[batchId];
    }

    function temperatureLimit(ProductType productType, StorageType storageType)
        external
        view
        returns (TempLimit memory)
    {
        return _limits[productType][storageType];
    }

    // --------------------------------------------------------------- internal

    function _existing(bytes32 batchId) internal view returns (Batch storage b) {
        b = _batches[batchId];
        if (b.createdAt == 0) revert BatchNotFound(batchId);
    }

    function _setStatus(bytes32 batchId, Batch storage b, Status to) internal {
        Status from = b.status;
        if (from == to) return;
        b.status = to;
        emit BatchStatusChanged(batchId, from, to);
    }

    function _quarantine(bytes32 batchId, Batch storage b, int16 recordedTemp, int16 limit) internal {
        b.statusBeforeQuarantine = b.status;
        _setStatus(batchId, b, Status.QUARANTINED);
        emit BatchQuarantined(batchId, recordedTemp, limit);
    }

    /// @dev Depth is at most four (carcass → cut → cone/skewer → serving lot) because every
    ///      transformation moves one product level up; fan-out is capped by MAX_INPUTS.
    function _isRecalled(bytes32 batchId) internal view returns (bool) {
        Batch storage b = _batches[batchId];
        if (b.recalled) return true;
        bytes32[] storage ps = b.parents;
        for (uint256 i; i < ps.length; ++i) {
            if (_isRecalled(ps[i])) return true;
        }
        return false;
    }

    function _hasBreach(bytes32 batchId) internal view returns (bool) {
        if (_coldChain[batchId].breaches > 0) return true;
        bytes32[] storage ps = _batches[batchId].parents;
        for (uint256 i; i < ps.length; ++i) {
            if (_hasBreach(ps[i])) return true;
        }
        return false;
    }

    function _countAncestors(bytes32 batchId) internal view returns (uint256 count) {
        bytes32[] storage ps = _batches[batchId].parents;
        count = ps.length;
        for (uint256 i; i < ps.length; ++i) {
            count += _countAncestors(ps[i]);
        }
    }

    function _pushUnique(bytes32[] memory arr, uint256 n, bytes32 id) private pure returns (uint256) {
        for (uint256 i; i < n; ++i) {
            if (arr[i] == id) return n;
        }
        arr[n] = id;
        return n + 1;
    }

    function _requireUsable(bytes32 batchId, Batch storage b) internal view {
        if (b.custodian != msg.sender) revert NotCustodian(batchId, msg.sender);
        if (b.status != Status.ACTIVE) revert InvalidStatus(batchId, b.status);
        if (_isRecalled(batchId)) revert BatchIsRecalled(batchId);
        if (b.useBy != 0 && block.timestamp > b.useBy) revert BatchExpired(batchId);
    }
}
