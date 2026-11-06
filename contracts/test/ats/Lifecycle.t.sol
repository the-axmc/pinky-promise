// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {AtsFixture} from "../utils/AtsFixture.sol";
import {WireBuilder as W} from "../utils/WireBuilder.sol";
import {IAtsToken} from "../../src/ats/IAtsToken.sol";
import {CustodyOracle} from "../../src/CustodyOracle.sol";
import {ReceiptMarket} from "../../src/ReceiptMarket.sol";

/// @notice The whole story on the real Asset Tokenization Studio contracts: a receipt token
///         deployed by the ATS Factory with the custody oracle as its compliance module and
///         freeze manager, traded through the market, restricted in transit, frozen on a
///         sensor-proven breach, released by an inspector and redeemed at delivery.
contract LifecycleTest is AtsFixture {
    uint256 internal constant DEVICE_KEY = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 internal constant ATTESTOR_KEY =
        0x5555555555555555555555555555555555555555555555555555555555555555;
    bytes32 internal constant LOT = bytes32("LOT-42");
    uint256 internal constant PRICE = 2 ether;

    CustodyOracle internal oracle;
    ReceiptMarket internal market;
    IAtsToken internal token;
    address internal device = vm.addr(DEVICE_KEY);
    address internal inspector = makeAddr("inspector");
    address internal alice = makeAddr("alice"); // the depositor: receives the receipt, sells part of it
    address internal bob = makeAddr("bob"); // an onboarded buyer
    address internal carol = makeAddr("carol"); // not onboarded
    uint64 internal seq = 10;

    function setUp() public {
        _loadAts();
        oracle = new CustodyOracle();
        market = new ReceiptMarket();
        token = _deployReceiptToken(address(oracle), address(oracle));

        _enableKycIssuer(token);
        _onboard(token, alice);
        _onboard(token, bob);
        vm.startPrank(issuer);
        token.addToControlList(address(market)); // a spender must be allowlisted (no KYC needed)
        oracle.registerLot(
            CustodyOracle.LotConfig({
                lotId: LOT,
                token: address(token),
                device: device,
                attestor: vm.addr(ATTESTOR_KEY),
                inspector: inspector,
                tempMinCenti: 200,
                tempMaxCenti: 800,
                rhMinCenti: 2000,
                rhMaxCenti: 7000
            })
        );
        vm.stopPrank();
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);
    }

    // --- helpers ---------------------------------------------------------------------------

    function _checkpoint(uint8 kind, uint8 decision, bool withBreach)
        internal
        returns (CustodyOracle.Outcome)
    {
        seq += 10;
        bytes memory cp = W.checkpoint(device, LOT, kind, seq);
        bytes memory att = W.attestation(cp, decision, withBreach);
        bytes memory deviceSig = W.sign(DEVICE_KEY, cp);
        bytes memory attestorSig = W.sign(ATTESTOR_KEY, att);
        bytes memory reading;
        bytes memory readingSig;
        if (withBreach) {
            reading = W.reading(device, LOT, 1260, 4550, seq - 1); // 12.60 C against a 2-8 C band
            readingSig = W.sign(DEVICE_KEY, reading);
        }
        uint256 gasBefore = gasleft();
        CustodyOracle.Outcome outcome =
            oracle.submitCheckpoint(cp, deviceSig, att, attestorSig, reading, readingSig);
        console2.log("submitCheckpoint gas", gasBefore - gasleft());
        return outcome;
    }

    function _state() internal view returns (CustodyOracle.LotState) {
        return oracle.getLot(LOT).state;
    }

    /// @dev Warehouse accepts the goods, the receipt is issued to alice, alice lists 40 units.
    function _issueAndList() internal returns (uint256 listingId) {
        _checkpoint(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        vm.prank(issuer);
        token.issue(alice, 100, "");
        vm.startPrank(alice);
        token.approve(address(market), 40);
        listingId = market.list(address(token), 40, PRICE);
        vm.stopPrank();
    }

    // --- the story -------------------------------------------------------------------------

    function test_fullLifecycle() public {
        // 1. Nothing can be issued before a venue has accepted the goods.
        vm.prank(issuer);
        vm.expectRevert();
        token.issue(alice, 100, "");

        // 2. Warehouse-in accepted: the receipt is issued and trades.
        uint256 listingId = _issueAndList();
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_CUSTODY));
        uint256 aliceBefore = alice.balance;
        vm.prank(bob);
        market.buy{value: 10 * PRICE}(listingId, 10);
        assertEq(token.balanceOf(bob), 10);
        assertEq(token.balanceOf(alice), 90);
        assertEq(alice.balance, aliceBefore + 10 * PRICE, "seller is paid in the same transaction");

        // 3. Warehouse-out accepted: in transit, the receipt cannot change hands.
        _checkpoint(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY, false);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_TRANSIT));
        vm.prank(bob);
        vm.expectRevert();
        market.buy{value: PRICE}(listingId, 1);
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1);

        // 4. At the dock 0G rejects the handoff and a signed 12.6 C reading proves the breach:
        //    every holder's units are frozen by the token itself.
        assertEq(uint8(_checkpoint(W.DOCK_HANDOFF, W.REJECT, true)), uint8(CustodyOracle.Outcome.FROZEN));
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.FROZEN));
        assertTrue(token.isFrozen(alice));
        assertTrue(token.isFrozen(bob));
        assertEq(token.getFrozenTokens(alice), 90);
        assertEq(token.getFrozenTokens(bob), 10);
        assertEq(token.balanceOf(alice), 0, "no free balance left");
        assertEq(token.getTotalBalanceFor(alice), 90, "the units are still alice's");
        vm.prank(bob);
        vm.expectRevert();
        market.buy{value: PRICE}(listingId, 1);

        //    Compliance work continues while frozen (it would not if we had paused the token).
        _onboard(token, carol);

        // 5. The inspector clears the lot: units unfreeze, custody is with the inspecting venue.
        vm.prank(inspector);
        oracle.release(LOT, keccak256("inspection report #1"), seq);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_CUSTODY));
        assertFalse(token.isFrozen(alice));
        assertEq(token.balanceOf(alice), 90);
        vm.prank(carol);
        market.buy{value: 5 * PRICE}(listingId, 5);
        assertEq(token.balanceOf(carol), 5);

        // 6. Final delivery accepted: no more trading, holders redeem.
        _checkpoint(W.FINAL_DELIVERY, W.ACCEPT_CUSTODY, false);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.DELIVERED));
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1);
        vm.prank(alice);
        token.redeem(85, "");
        vm.prank(bob);
        token.redeem(10, "");
        vm.prank(carol);
        token.redeem(5, "");
        assertEq(token.totalSupply(), 0);

        assertEq(oracle.historyLength(LOT), 5, "four checkpoints and one release");
    }

    function test_rejectWithoutBreachLeavesTheTokenAlone() public {
        uint256 listingId = _issueAndList();
        _checkpoint(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY, false);
        assertEq(uint8(_checkpoint(W.DOCK_HANDOFF, W.REJECT, false)), uint8(CustodyOracle.Outcome.REFUSED));
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_TRANSIT));
        assertFalse(token.isFrozen(alice));
        listingId;
    }

    function test_freezeIsDeferredWhileTheIssuerHasTheTokenPaused() public {
        _issueAndList();
        _checkpoint(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY, false);
        vm.prank(issuer);
        token.pause();

        _checkpoint(W.DOCK_HANDOFF, W.REJECT, true);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.FROZEN), "the lot freezes regardless");
        assertTrue(oracle.freezePending(LOT));
        assertEq(token.getFrozenTokens(alice), 0);

        vm.prank(issuer);
        token.unpause();
        oracle.continueFreeze(LOT);
        assertFalse(oracle.freezePending(LOT));
        assertEq(token.getFrozenTokens(alice), 100);
    }

    /// Gas estimators look for the smallest limit that does not revert. If a starved freeze or
    /// unfreeze were silently "deferred", they would settle on a limit at which nothing is
    /// frozen or unfrozen. (This was caught by the end-to-end test against the gateway.)
    function test_starvedReleaseRevertsInsteadOfSkippingTheUnfreeze() public {
        _issueAndList();
        _checkpoint(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY, false);
        _checkpoint(W.DOCK_HANDOFF, W.REJECT, true);
        assertEq(token.getFrozenTokens(alice), 100);

        // Enough gas for the oracle's own bookkeeping, not for the token's unfreeze.
        vm.prank(inspector);
        (bool ok,) = address(oracle).call{gas: 150_000}(
            abi.encodeCall(CustodyOracle.release, (LOT, keccak256("report"), seq))
        );
        assertFalse(ok, "a starved release must revert");
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.FROZEN));

        vm.prank(inspector);
        oracle.release(LOT, keccak256("report"), seq);
        assertEq(token.getFrozenTokens(alice), 0);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_CUSTODY));
    }

    function test_starvedFreezeRevertsInsteadOfSkippingTheFreeze() public {
        _issueAndList();
        _checkpoint(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY, false);

        seq += 10;
        bytes memory cp = W.checkpoint(device, LOT, W.DOCK_HANDOFF, seq);
        bytes memory att = W.attestation(cp, W.REJECT, true);
        bytes memory reading = W.reading(device, LOT, 1260, 4550, seq - 1);
        bytes memory call_ = abi.encodeCall(
            CustodyOracle.submitCheckpoint,
            (cp, W.sign(DEVICE_KEY, cp), att, W.sign(ATTESTOR_KEY, att), reading, W.sign(DEVICE_KEY, reading))
        );
        (bool ok,) = address(oracle).call{gas: 260_000}(call_);
        assertFalse(ok, "a starved freeze must revert");
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_TRANSIT));

        (ok,) = address(oracle).call(call_);
        assertTrue(ok);
        assertEq(token.getFrozenTokens(alice), 100);
    }

    // --- market ----------------------------------------------------------------------------

    function test_buyerWithoutKycCannotBuyAndKeepsTheirMoney() public {
        uint256 listingId = _issueAndList();
        uint256 before = carol.balance;
        vm.prank(carol);
        vm.expectRevert();
        market.buy{value: PRICE}(listingId, 1);
        assertEq(carol.balance, before);
        assertEq(token.balanceOf(carol), 0);
    }

    function test_marketChecksPaymentAndStock() public {
        uint256 listingId = _issueAndList();
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(ReceiptMarket.WrongPayment.selector, 2 * PRICE, PRICE));
        market.buy{value: PRICE}(listingId, 2);
        vm.expectRevert(abi.encodeWithSelector(ReceiptMarket.NotEnoughUnits.selector, 41, 40));
        market.buy{value: 41 * PRICE}(listingId, 41);
        market.buy{value: 40 * PRICE}(listingId, 40);
        vm.expectRevert(abi.encodeWithSelector(ReceiptMarket.NotActive.selector, listingId));
        market.buy{value: PRICE}(listingId, 1);
        vm.stopPrank();
        assertEq(token.balanceOf(bob), 40);
        assertFalse(market.getListing(listingId).active);
    }

    function test_onlyTheSellerCancels() public {
        uint256 listingId = _issueAndList();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ReceiptMarket.NotSeller.selector, bob));
        market.cancel(listingId);
        vm.prank(alice);
        market.cancel(listingId);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ReceiptMarket.NotActive.selector, listingId));
        market.buy{value: PRICE}(listingId, 1);
    }

    function test_listingsArePaged() public {
        uint256 first = _issueAndList();
        vm.prank(alice);
        uint256 second = market.list(address(token), 5, PRICE * 2);
        assertEq(market.listingCount(), 2);
        (uint256[] memory ids, ReceiptMarket.Listing[] memory page) = market.getListings(0, 10);
        assertEq(ids.length, 2);
        assertEq(ids[0], first);
        assertEq(ids[1], second);
        assertEq(page[0].unitsLeft, 40);
        assertEq(page[1].pricePerUnit, PRICE * 2);
        (ids,) = market.getListings(5, 10);
        assertEq(ids.length, 0);
    }
}
