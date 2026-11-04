// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BatchStorage} from "./BatchStorage.sol";
import {
    ProductType, StorageType, Status, Batch, Device, Shipment, ColdChainSummary, TempLimit
} from "../PorkTypes.sol";

/// @title Cold-chain monitor (Sections 3.2, 5.4, 6.5)
/// @notice Stores signed temperature summaries from IoT gateways, compares them with the
///         product-specific limit set by the authority and quarantines batches on a breach.
///         Temperatures are int16 in tenths of a degree Celsius (7 °C = 70, −18 °C = −180).
abstract contract ColdChainMonitor is BatchStorage {
    event LimitSet(ProductType indexed productType, StorageType indexed storageType, int16 maxTemp);
    event CookingMinimumSet(int16 minTemp);
    event TemperatureReported(
        bytes32 indexed batchId,
        address indexed device,
        bytes32 locationId,
        int16 minTemp,
        int16 maxTemp,
        int16 meanTemp,
        uint32 minutesOut,
        bytes32 seriesHash,
        bool breach
    );
    event QuarantineReleased(bytes32 indexed batchId, address indexed authority, bytes32 reasonHash);

    error InvalidTemperatureSummary();
    error InvalidBatchCount();
    error NotHeldByDeviceOrganisation(bytes32 batchId, address org);

    function setTemperatureLimit(ProductType productType, StorageType storageType, int16 maxTemp)
        external
        onlyRole(AUTHORITY_ROLE)
    {
        _setLimit(productType, storageType, maxTemp);
    }

    function setCookingMinimum(int16 minTemp) external onlyRole(AUTHORITY_ROLE) {
        minCookingTemp = minTemp;
        emit CookingMinimumSet(minTemp);
    }

    /// @notice Summary of one reporting window from a registered gateway. The full series stays
    ///         off-chain; `seriesHash` is its SHA-256. A batch may be reported on by a device of the
    ///         organisation that holds it, or of the carrier while it is in transit.
    function reportTemperature(
        bytes32[] calldata batchIds,
        int16 minTemp,
        int16 maxTemp,
        int16 meanTemp,
        uint32 minutesOut,
        bytes32 seriesHash
    ) external onlyRole(SENSOR_ROLE) {
        Device storage d = _devices[msg.sender];
        if (!d.active) revert DeviceNotActive(msg.sender);
        if (batchIds.length == 0 || batchIds.length > MAX_BATCHES_PER_REPORT) revert InvalidBatchCount();
        if (minTemp > meanTemp || meanTemp > maxTemp) revert InvalidTemperatureSummary();

        for (uint256 i; i < batchIds.length; ++i) {
            bytes32 id = batchIds[i];
            Batch storage b = _existing(id);
            Shipment storage s = _shipments[id];
            bool held = !s.active && b.custodian == d.org;
            bool carried = s.active && s.carrier == d.org;
            if (!held && !carried) revert NotHeldByDeviceOrganisation(id, d.org);

            TempLimit memory lim = _limits[b.productType][b.storageType];
            bool breach = lim.set && maxTemp > lim.maxTemp;

            ColdChainSummary storage c = _coldChain[id];
            if (c.reports == 0 || maxTemp > c.maxTemp) c.maxTemp = maxTemp;
            c.reports += 1;
            c.lastReportAt = uint64(block.timestamp);
            if (breach) c.breaches += 1;

            emit TemperatureReported(id, msg.sender, d.locationId, minTemp, maxTemp, meanTemp, minutesOut, seriesHash, breach);

            if (
                breach
                    && (
                        b.status == Status.ACTIVE || b.status == Status.IN_TRANSIT
                            || b.status == Status.PENDING_INSPECTION
                    )
            ) {
                _quarantine(id, b, maxTemp, lim.maxTemp);
            }
        }
    }

    /// @notice The authority releases a quarantined batch; it returns to the state it was in before.
    function releaseQuarantine(bytes32 batchId, bytes32 reasonHash) external onlyRole(AUTHORITY_ROLE) {
        Batch storage b = _existing(batchId);
        if (b.status != Status.QUARANTINED) revert InvalidStatus(batchId, b.status);
        _setStatus(batchId, b, b.statusBeforeQuarantine);
        emit QuarantineReleased(batchId, msg.sender, reasonHash);
    }

    function _setLimit(ProductType productType, StorageType storageType, int16 maxTemp) internal {
        _limits[productType][storageType] = TempLimit({maxTemp: maxTemp, set: true});
        emit LimitSet(productType, storageType, maxTemp);
    }
}
