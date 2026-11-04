// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TraceabilityRegistry} from "./modules/TraceabilityRegistry.sol";
import {ColdChainMonitor} from "./modules/ColdChainMonitor.sol";
import {RecallManager} from "./modules/RecallManager.sol";
import {ProductType, StorageType} from "./PorkTypes.sol";

/// @title PorkTraceability
/// @notice Blockchain traceability for pork in food service: slaughterhouse → cutting plant →
///         meat processor → refrigerated transport → souvlaki restaurant → consumer.
///         Deployed on a private, permissioned Hyperledger Besu network (QBFT, zero gas price).
///         Composes four modules: access control, traceability registry,
///         cold-chain monitor and recall manager.
///         New batches start in PENDING_INSPECTION (carcasses) or ACTIVE (transformation outputs);
///         every later status change emits BatchStatusChanged.
contract PorkTraceability is TraceabilityRegistry, ColdChainMonitor, RecallManager {
    /// @param admin Consortium administrator (ADMIN role): onboards organisations and devices.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        // Default limits (tenths of °C). The authority can change them with setTemperatureLimit.
        _setLimit(ProductType.CARCASS, StorageType.CHILLED, 70); // Reg. 853/2004 Annex III Sec. I: ≤ 7 °C
        _setLimit(ProductType.PRIMAL_CUT, StorageType.CHILLED, 70);
        _setLimit(ProductType.CARCASS, StorageType.FROZEN, -180);
        _setLimit(ProductType.PRIMAL_CUT, StorageType.FROZEN, -180);
        _setLimit(ProductType.GYROS_CONE, StorageType.CHILLED, 40); // Sec. V meat preparations: ≤ 4 °C
        _setLimit(ProductType.SKEWER, StorageType.CHILLED, 40);
        _setLimit(ProductType.GYROS_CONE, StorageType.FROZEN, -180); // ≤ −18 °C
        _setLimit(ProductType.SKEWER, StorageType.FROZEN, -180);
        minCookingTemp = 750; // HACCP plan, e.g. 75 °C core
        emit CookingMinimumSet(750);
    }
}
