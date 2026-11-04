// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Product types along the chain. Each transformation moves one level up.
enum ProductType {
    CARCASS,
    PRIMAL_CUT,
    GYROS_CONE,
    SKEWER,
    SERVING_LOT
}

/// @notice Storage regime; selects the temperature limit.
enum StorageType {
    CHILLED,
    FROZEN
}

/// @notice Batch life cycle.
enum Status {
    PENDING_INSPECTION,
    ACTIVE,
    IN_TRANSIT,
    QUARANTINED,
    REJECTED,
    CONSUMED,
    RECALLED
}

/// @notice Countries as ISO 3166-1 alpha-2 codes. "XX" means mixed origin.
struct Origin {
    bytes2 countryOfBirth;
    bytes2 countryOfRearing;
    bytes2 countryOfSlaughter;
}

/// @notice The unit of traceability.
struct Batch {
    ProductType productType;
    StorageType storageType;
    Status status;
    Status statusBeforeQuarantine; // restored when the authority releases a quarantine
    bool recalled; // recall flag written on this batch only; descendants are resolved by isRecalled()
    uint32 units; // count of skewers / portions; 0 when not applicable
    uint64 createdAt;
    uint64 useBy; // 0 for carcasses
    uint64 slaughterTime; // earliest slaughter time in the batch's ancestry
    address custodian; // organisation currently holding the batch
    address creator; // organisation that created the batch (may recall it)
    uint256 quantity; // net meat in grams at creation
    uint256 remaining; // net meat in grams still available
    Origin origin;
    bytes32 docHash; // hash of the supporting off-chain document
    bytes32[] parents; // input batches of the transformation that created this batch
}

struct Organisation {
    string approvalNo;
    bytes2 country;
    bool registered;
}

struct Device {
    address org;
    bytes32 locationId; // chiller, vehicle, cold room or refrigerator
    bool active;
}

struct Inspection {
    address veterinarian;
    uint64 inspectedAt;
    bool passed; // ante- and post-mortem result
    bool trichinellaNegative;
    bytes32 reportHash;
}

struct Shipment {
    address sender;
    address recipient;
    address carrier;
    uint64 shippedAt;
    bytes32 docHash; // delivery note
    bool active;
}

struct ColdChainSummary {
    uint32 reports;
    uint32 breaches;
    int16 maxTemp; // highest maximum reported, tenths of °C
    uint64 lastReportAt;
}

struct TempLimit {
    int16 maxTemp; // tenths of °C
    bool set;
}

struct Cooking {
    int16 coreTemp; // tenths of °C
    bool recorded;
    bool meetsMinimum;
    uint64 recordedAt;
    bytes32 logHash;
}

struct Recall {
    address issuer;
    uint64 issuedAt;
    uint16 reasonCode;
    bytes32 noticeHash;
}
