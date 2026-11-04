// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BatchStorage} from "./BatchStorage.sol";
import {Status, Batch, Recall} from "../PorkTypes.sol";

/// @title Recall manager
/// @notice A recall writes one flag on the recalled batch. Every descendant is treated as recalled
///         from that moment because isRecalled() walks the ancestry; forward propagation for
///         notifications is computed off-chain by the indexer from the events.
abstract contract RecallManager is BatchStorage {
    event RecallIssued(bytes32 indexed batchId, address indexed issuer, uint16 reasonCode, bytes32 noticeHash);

    error NotAuthorisedToRecall(bytes32 batchId, address caller);
    error AlreadyRecalled(bytes32 batchId);

    /// @notice Callable by the competent authority or by the organisation that created the batch.
    ///         Can be issued in any state.
    function issueRecall(bytes32 batchId, uint16 reasonCode, bytes32 noticeHash) external {
        Batch storage b = _existing(batchId);
        if (!hasRole(AUTHORITY_ROLE, msg.sender) && msg.sender != b.creator) {
            revert NotAuthorisedToRecall(batchId, msg.sender);
        }
        if (b.recalled) revert AlreadyRecalled(batchId);

        b.recalled = true;
        _recalls[batchId] = Recall({
            issuer: msg.sender,
            issuedAt: uint64(block.timestamp),
            reasonCode: reasonCode,
            noticeHash: noticeHash
        });
        _setStatus(batchId, b, Status.RECALLED);
        emit RecallIssued(batchId, msg.sender, reasonCode, noticeHash);
    }
}
