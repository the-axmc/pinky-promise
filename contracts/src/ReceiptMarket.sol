// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAtsToken} from "./ats/IAtsToken.sol";

/// @title ReceiptMarket
/// @notice A minimal secondary market for ATS warehouse receipts: a holder lists units at a fixed
///         price in the chain's native currency (HBAR on Hedera) and a buyer takes them in one
///         atomic transaction.
///
///         The market enforces no rules of its own. It moves units with `transferFrom`, so every
///         purchase passes through the token's own checks: the buyer must be allowlisted and
///         KYC'd, the seller's units must not be frozen, and the custody oracle must allow
///         transfers. If the lot is in transit or frozen the purchase reverts and the buyer keeps
///         their money.
/// @dev Setup per token: the issuer adds this contract to the token's allowlist (ATS requires a
///      spender to be allowlisted; it needs no KYC), and the seller approves it for the units.
///
///      Prices are in the unit `msg.value` is denominated in. On Hedera that is the tinybar
///      (1 HBAR = 100,000,000 tinybar) even though JSON-RPC wallets send 18-decimal values; the
///      relay converts.
contract ReceiptMarket {
    struct Listing {
        address seller;
        address token;
        uint256 unitsLeft;
        uint256 pricePerUnit;
        bool active;
    }

    Listing[] private _listings;
    bool private _entered;

    event Listed(
        uint256 indexed listingId,
        address indexed token,
        address indexed seller,
        uint256 units,
        uint256 pricePerUnit
    );
    event Purchased(uint256 indexed listingId, address indexed buyer, uint256 units, uint256 paid);
    event Cancelled(uint256 indexed listingId);

    error InvalidListing(string reason);
    error UnknownListing(uint256 listingId);
    error NotSeller(address caller);
    error NotActive(uint256 listingId);
    error NotEnoughUnits(uint256 requested, uint256 available);
    error WrongPayment(uint256 expected, uint256 sent);
    error TransferRefused();
    error PaymentFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    /// @notice Offers `units` of `token` at `pricePerUnit`. The seller keeps the units until
    ///         they are bought and must have approved this contract for them.
    function list(address token, uint256 units, uint256 pricePerUnit) external returns (uint256 listingId) {
        if (token == address(0)) revert InvalidListing("token");
        if (units == 0) revert InvalidListing("units");
        if (pricePerUnit == 0) revert InvalidListing("price");
        listingId = _listings.length;
        _listings.push(
            Listing({
                seller: msg.sender, token: token, unitsLeft: units, pricePerUnit: pricePerUnit, active: true
            })
        );
        emit Listed(listingId, token, msg.sender, units, pricePerUnit);
    }

    /// @notice Buys `units` from a listing for exactly `units * pricePerUnit`.
    function buy(uint256 listingId, uint256 units) external payable nonReentrant {
        if (listingId >= _listings.length) revert UnknownListing(listingId);
        Listing storage listing = _listings[listingId];
        if (!listing.active) revert NotActive(listingId);
        if (units == 0 || units > listing.unitsLeft) revert NotEnoughUnits(units, listing.unitsLeft);
        uint256 cost = units * listing.pricePerUnit;
        if (msg.value != cost) revert WrongPayment(cost, msg.value);

        listing.unitsLeft -= units;
        if (listing.unitsLeft == 0) listing.active = false;

        // The token decides whether this transfer is allowed; a refusal reverts the purchase.
        if (!IAtsToken(listing.token).transferFrom(listing.seller, msg.sender, units)) {
            revert TransferRefused();
        }

        (bool paid,) = payable(listing.seller).call{value: cost}("");
        if (!paid) revert PaymentFailed();
        emit Purchased(listingId, msg.sender, units, cost);
    }

    function cancel(uint256 listingId) external {
        if (listingId >= _listings.length) revert UnknownListing(listingId);
        Listing storage listing = _listings[listingId];
        if (msg.sender != listing.seller) revert NotSeller(msg.sender);
        if (!listing.active) revert NotActive(listingId);
        listing.active = false;
        emit Cancelled(listingId);
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        if (listingId >= _listings.length) revert UnknownListing(listingId);
        return _listings[listingId];
    }

    /// @notice A page of listings (active or not), with their ids, oldest first.
    function getListings(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Listing[] memory page)
    {
        uint256 total = _listings.length;
        if (offset >= total) return (new uint256[](0), new Listing[](0));
        uint256 end = offset + limit;
        if (end > total) end = total;
        ids = new uint256[](end - offset);
        page = new Listing[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = i;
            page[i - offset] = _listings[i];
        }
    }
}
