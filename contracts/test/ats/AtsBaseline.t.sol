// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {AtsFixture} from "../utils/AtsFixture.sol";
import {IAtsToken, ICompliance} from "../../src/ats/IAtsToken.sol";

/// @dev A compliance module whose answers the test can steer, to observe exactly when and with
///      which arguments ATS consults `canTransfer`.
contract ProbeCompliance is ICompliance {
    bool public blockTransfers;
    bool public blockMints;
    bool public blockRedemptions;
    uint256 public transferredCalls;
    uint256 public createdCalls;
    uint256 public destroyedCalls;

    function set(bool transfers_, bool mints_, bool redemptions_) external {
        blockTransfers = transfers_;
        blockMints = mints_;
        blockRedemptions = redemptions_;
    }

    function canTransfer(address from, address to, uint256) external view returns (bool) {
        if (from == address(0)) return !blockMints;
        if (to == address(0)) return !blockRedemptions;
        return !blockTransfers;
    }

    function transferred(address, address, uint256) external {
        transferredCalls++;
    }

    function created(address, uint256) external {
        createdCalls++;
    }

    function destroyed(address, uint256) external {
        destroyedCalls++;
    }
}

/// @dev Stands in for a marketplace: moves tokens with `transferFrom`.
contract Spender {
    function pull(IAtsToken token, address from, address to, uint256 amount) external {
        token.transferFrom(from, to, amount);
    }
}

/// @notice Pins down the Asset Tokenization Studio behaviours the custody oracle and the receipt
///         market are built on. If a future ATS release changes one of them, this fails first.
contract AtsBaselineTest is AtsFixture {
    ProbeCompliance internal probe;
    IAtsToken internal token;
    address internal freezer = makeAddr("freezer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol"); // never onboarded

    function setUp() public {
        _loadAts();
        probe = new ProbeCompliance();
        uint256 gasBefore = gasleft();
        token = _deployReceiptToken(address(probe), freezer);
        console2.log("deployEquity gas", gasBefore - gasleft());
        _enableKycIssuer(token);
        _onboard(token, alice);
        _onboard(token, bob);
        vm.prank(issuer);
        token.issue(alice, 100, "");
    }

    function test_factoryDeploysConfiguredToken() public view {
        assertEq(token.name(), "Warehouse Receipt LOT-42");
        assertEq(token.symbol(), "WR42");
        assertEq(token.decimals(), 0);
        assertEq(token.totalSupply(), 100);
        assertEq(token.balanceOf(alice), 100);
        assertEq(token.compliance(), address(probe));
        assertTrue(token.getControlListType(), "allowlist mode");
        assertTrue(token.isInternalKycActivated());
        assertEq(token.getTotalSecurityHolders(), 1);
        assertEq(probe.createdCalls(), 1, "issue notifies compliance.created");
    }

    function test_transferBetweenOnboardedInvestors() public {
        vm.prank(alice);
        token.transfer(bob, 40);
        assertEq(token.balanceOf(bob), 40);
        assertEq(probe.transferredCalls(), 1, "transfer notifies compliance.transferred");
        assertEq(token.getTotalSecurityHolders(), 2);
    }

    function test_complianceModuleCanBlockTransfers() public {
        probe.set(true, false, false);
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1);
    }

    function test_complianceModuleCanBlockMints() public {
        probe.set(false, true, false);
        vm.prank(issuer);
        vm.expectRevert();
        token.issue(alice, 1, "");
    }

    function test_complianceModuleCanBlockRedemptions() public {
        probe.set(false, false, true);
        vm.prank(alice);
        vm.expectRevert();
        token.redeem(1, "");
    }

    function test_holderRedeems() public {
        vm.prank(alice);
        token.redeem(30, "");
        assertEq(token.balanceOf(alice), 70);
        assertEq(token.totalSupply(), 70);
        assertEq(probe.destroyedCalls(), 1, "redeem notifies compliance.destroyed");
    }

    function test_transferToNonOnboardedInvestorReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(carol, 1);
    }

    function test_allowlistWithoutKycIsNotEnough() public {
        vm.prank(issuer);
        token.addToControlList(carol);
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(carol, 1);
    }

    /// Freezing a holder's units is what the oracle does on a confirmed breach.
    function test_tokenFreezeLocksUnitsAndUnfreezeReleasesThem() public {
        vm.prank(freezer);
        token.freezePartialTokens(alice, 100);
        assertTrue(token.isFrozen(alice));
        assertEq(token.getFrozenTokens(alice), 100);
        assertEq(token.balanceOf(alice), 0, "balanceOf reports only the free balance");
        assertEq(token.getTotalBalanceFor(alice), 100, "frozen units still belong to the holder");
        assertEq(token.totalSupply(), 100);
        assertEq(token.getTotalSecurityHolders(), 1, "a fully frozen holder is still a holder");
        assertTrue(token.isInControlList(alice), "the investor stays allowlisted");

        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1);
        vm.prank(alice);
        vm.expectRevert();
        token.redeem(1, "");

        vm.prank(freezer);
        token.unfreezePartialTokens(alice, 100);
        assertFalse(token.isFrozen(alice));
        vm.prank(alice);
        token.transfer(bob, 1);
        assertEq(token.balanceOf(bob), 1);
    }

    function test_partialTokenFreezeLeavesTheRestTransferable() public {
        vm.prank(freezer);
        token.freezePartialTokens(alice, 60);
        vm.prank(alice);
        token.transfer(bob, 40);
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1);
    }

    function test_cannotFreezeMoreThanTheBalance() public {
        vm.prank(freezer);
        vm.expectRevert();
        token.freezePartialTokens(alice, 101);
    }

    function test_batchTokenFreeze() public {
        vm.prank(alice);
        token.transfer(bob, 30);
        address[] memory who = new address[](2);
        who[0] = alice;
        who[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 70;
        amounts[1] = 30;
        vm.prank(freezer);
        token.batchFreezePartialTokens(who, amounts);
        assertEq(token.getFrozenTokens(alice), 70);
        assertEq(token.getFrozenTokens(bob), 30);
        vm.prank(freezer);
        token.batchUnfreezePartialTokens(who, amounts);
        assertFalse(token.isFrozen(alice));
        assertFalse(token.isFrozen(bob));
    }

    /// ATS implements the ERC-3643 address freeze as "take the address off the allowlist".
    /// `isFrozen` does not reflect it, which is why the oracle freezes units instead.
    function test_addressFreezeIsAllowlistRemoval() public {
        vm.prank(freezer);
        token.setAddressFrozen(alice, true);
        assertFalse(token.isFrozen(alice));
        assertFalse(token.isInControlList(alice));
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1);

        vm.prank(freezer);
        token.setAddressFrozen(alice, false);
        assertTrue(token.isInControlList(alice));
        vm.prank(alice);
        token.transfer(bob, 1);
    }

    function test_onlyFreezeRoleCanFreeze() public {
        vm.prank(issuer);
        vm.expectRevert();
        token.freezePartialTokens(alice, 1);
    }

    /// A marketplace contract only has to be allowlisted — not KYC'd — to move tokens, but it
    /// must be allowlisted before a holder can even approve it.
    function test_spenderMustBeAllowlistedButNotKycd() public {
        Spender spender = new Spender();
        vm.prank(alice);
        vm.expectRevert();
        token.approve(address(spender), 10);

        vm.prank(issuer);
        token.addToControlList(address(spender));
        vm.prank(alice);
        token.approve(address(spender), 10);
        spender.pull(token, alice, bob, 10);
        assertEq(token.balanceOf(bob), 10);
        assertEq(token.getKycStatusFor(address(spender)), 0, "spender has no KYC");
    }

    function test_pauseBlocksTransfersAndAdminCalls() public {
        vm.prank(issuer);
        token.pause();
        assertTrue(token.paused());

        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1);
        // The reason the oracle is wired in as the compliance module rather than as an external
        // pause: a paused token also refuses KYC grants and freezes.
        vm.prank(freezer);
        vm.expectRevert();
        token.freezePartialTokens(alice, 1);

        vm.prank(issuer);
        token.unpause();
        vm.prank(alice);
        token.transfer(bob, 1);
    }

    function test_holderEnumeration() public {
        vm.prank(alice);
        token.transfer(bob, 5);
        address[] memory holders = token.getSecurityHolders(0, 10);
        assertEq(holders.length, 2);
        assertEq(holders[0], alice);
        assertEq(holders[1], bob);
    }
}
