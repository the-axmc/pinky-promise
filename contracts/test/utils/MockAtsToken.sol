// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICompliance} from "../../src/ats/IAtsToken.sol";

/// @notice The few ATS token behaviours the custody oracle touches, reimplemented so its unit
///         tests can steer them (many holders, failing freezes). Behaviour that matters is also
///         tested against the real ATS contracts in test/ats.
contract MockAtsToken {
    address public admin;
    address public compliance;
    address public freezer;
    bool public failFreeze; // stands for "token paused" or "freeze role not granted"

    mapping(address => uint256) private _free;
    mapping(address => uint256) private _frozen;
    address[] private _holders;
    mapping(address => bool) private _isHolder;

    constructor(address admin_, address compliance_) {
        admin = admin_;
        compliance = compliance_;
        freezer = compliance_;
    }

    function setFailFreeze(bool value) external {
        failFreeze = value;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return role == bytes32(0) && account == admin;
    }

    function balanceOf(address holder) external view returns (uint256) {
        return _free[holder];
    }

    function getFrozenTokens(address holder) external view returns (uint256) {
        return _frozen[holder];
    }

    function getTotalSecurityHolders() external view returns (uint256) {
        return _holders.length;
    }

    function getSecurityHolders(uint256 pageIndex, uint256 pageLength)
        external
        view
        returns (address[] memory page)
    {
        uint256 start = pageIndex * pageLength;
        if (start >= _holders.length) return new address[](0);
        uint256 end = start + pageLength;
        if (end > _holders.length) end = _holders.length;
        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            page[i - start] = _holders[i];
        }
    }

    function issue(address to, uint256 amount) external {
        require(msg.sender == admin, "not issuer");
        require(ICompliance(compliance).canTransfer(address(0), to, amount), "compliance: issue");
        _credit(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(ICompliance(compliance).canTransfer(msg.sender, to, amount), "compliance: transfer");
        _free[msg.sender] -= amount;
        _credit(to, amount);
        return true;
    }

    function redeem(uint256 amount) external {
        require(ICompliance(compliance).canTransfer(msg.sender, address(0), amount), "compliance: redeem");
        _free[msg.sender] -= amount;
    }

    function freezePartialTokens(address holder, uint256 amount) external {
        require(msg.sender == freezer, "not freeze manager");
        require(!failFreeze, "freeze unavailable");
        _free[holder] -= amount;
        _frozen[holder] += amount;
    }

    function unfreezePartialTokens(address holder, uint256 amount) external {
        require(msg.sender == freezer, "not freeze manager");
        require(!failFreeze, "freeze unavailable");
        _frozen[holder] -= amount;
        _free[holder] += amount;
    }

    function _credit(address to, uint256 amount) private {
        _free[to] += amount;
        if (!_isHolder[to]) {
            _isHolder[to] = true;
            _holders.push(to);
        }
    }
}
