// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Organisation, Device} from "../PorkTypes.sol";

/// @title Access control module
/// @notice Registers organisations and IoT gateways and assigns the on-chain roles.
///         Every role except SENSOR may only be held by a registered organisation;
///         SENSOR may only be held by an active registered device.
abstract contract AccessRegistry is AccessControl {
    /// @dev The consortium administrator uses OpenZeppelin's DEFAULT_ADMIN_ROLE.
    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;
    bytes32 public constant SLAUGHTERHOUSE_ROLE = keccak256("SLAUGHTERHOUSE");
    bytes32 public constant VETERINARIAN_ROLE = keccak256("VETERINARIAN");
    bytes32 public constant CUTTING_PLANT_ROLE = keccak256("CUTTING_PLANT");
    bytes32 public constant PROCESSOR_ROLE = keccak256("PROCESSOR");
    bytes32 public constant CARRIER_ROLE = keccak256("CARRIER");
    bytes32 public constant SENSOR_ROLE = keccak256("SENSOR");
    bytes32 public constant RETAILER_ROLE = keccak256("RETAILER");
    bytes32 public constant AUTHORITY_ROLE = keccak256("AUTHORITY");

    mapping(address => Organisation) internal _orgs;
    mapping(address => Device) internal _devices;

    event OrganisationRegistered(address indexed org, string approvalNo, bytes2 country, bytes32[] roles);
    event DeviceRegistered(address indexed device, address indexed org, bytes32 locationId);
    event DeviceDeactivated(address indexed device);

    error ZeroAddress();
    error InvalidCountry();
    error AlreadyRegistered(address account);
    error OrganisationNotRegistered(address account);
    error DeviceNotActive(address device);
    error UnknownRole(bytes32 role);

    // ------------------------------------------------------------------ admin

    function registerOrganisation(address org, string calldata approvalNo, bytes2 country, bytes32[] calldata roles)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (org == address(0)) revert ZeroAddress();
        if (country == bytes2(0)) revert InvalidCountry();
        if (_orgs[org].registered || _devices[org].org != address(0)) revert AlreadyRegistered(org);

        _orgs[org] = Organisation({approvalNo: approvalNo, country: country, registered: true});
        for (uint256 i; i < roles.length; ++i) {
            if (!_isOrganisationRole(roles[i])) revert UnknownRole(roles[i]);
            _grantRole(roles[i], org);
        }
        emit OrganisationRegistered(org, approvalNo, country, roles);
    }

    function registerDevice(address device, address org, bytes32 locationId) external onlyRole(ADMIN_ROLE) {
        if (device == address(0)) revert ZeroAddress();
        if (!_orgs[org].registered) revert OrganisationNotRegistered(org);
        if (_orgs[device].registered || _devices[device].org != address(0)) revert AlreadyRegistered(device);

        _devices[device] = Device({org: org, locationId: locationId, active: true});
        _grantRole(SENSOR_ROLE, device);
        emit DeviceRegistered(device, org, locationId);
    }

    /// @notice Disables a lost or compromised gateway. Its past reports stay on the ledger.
    function deactivateDevice(address device) external onlyRole(ADMIN_ROLE) {
        if (!_devices[device].active) revert DeviceNotActive(device);
        _devices[device].active = false;
        _revokeRole(SENSOR_ROLE, device);
        emit DeviceDeactivated(device);
    }

    // ------------------------------------------------------------------ views

    function getOrganisation(address org) external view returns (Organisation memory) {
        return _orgs[org];
    }

    function getDevice(address dev) external view returns (Device memory) {
        return _devices[dev];
    }

    // --------------------------------------------------------------- internal

    /// @dev Keeps roles bound to registered identities, also when granted through grantRole().
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (role == SENSOR_ROLE) {
            if (!_devices[account].active) revert DeviceNotActive(account);
        } else if (role != DEFAULT_ADMIN_ROLE) {
            if (!_isOrganisationRole(role)) revert UnknownRole(role);
            if (!_orgs[account].registered) revert OrganisationNotRegistered(account);
        }
        return super._grantRole(role, account);
    }

    function _isOrganisationRole(bytes32 role) internal pure returns (bool) {
        return role == ADMIN_ROLE || role == SLAUGHTERHOUSE_ROLE || role == VETERINARIAN_ROLE
            || role == CUTTING_PLANT_ROLE || role == PROCESSOR_ROLE || role == CARRIER_ROLE || role == RETAILER_ROLE
            || role == AUTHORITY_ROLE;
    }
}
