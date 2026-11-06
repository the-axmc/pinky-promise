// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ArkivDevEngine
/// @notice A Solidity stand-in for Arkiv's native entity engine, for local development only.
///         The local devnet installs this bytecode at the Arkiv address on a plain anvil chain so
///         that the unmodified Arkiv SDK can create, patch, extend, transfer and delete entities
///         offline. It follows the public write-transaction specification
///         (docs.arkiv.network/json-rpc/mutating-entities): the same `execute` entry point, the
///         same operation payloads, key derivation, events and custom errors.
/// @dev It is NOT the real engine. Entity attributes are not kept in contract storage; they are
///      published in the dev-only `DevAttributes` event and an off-chain indexer (the devnet's
///      JSON-RPC proxy) rebuilds entities from the logs to answer `arkiv_query`. Never deploy it
///      to a public network.
contract ArkivDevEngine {
    // -----------------------------------------------------------------------------------------
    // Wire types (see the specification)
    // -----------------------------------------------------------------------------------------

    struct Operation {
        uint8 operation;
        bytes operationData;
    }

    struct Attribute {
        bytes32 name; // ASCII, left-aligned, zero-padded
        uint8 typeId; // low 7 bits: type; bit 7: indexed
        bytes value;
    }

    struct CreateOp {
        uint128 salt;
        uint64 expiresAt;
        uint64 minLifetime;
        uint8 creationFlags;
        Attribute[] attributes;
    }

    struct PatchOp {
        bytes32 entityKey;
        Attribute[] mutations;
    }

    struct ExtendOp {
        bytes32 entityKey;
        uint64 expiresAt;
        uint64 minLifetime;
    }

    struct TransferOp {
        bytes32 entityKey;
        address newOwner;
    }

    struct DeleteOp {
        bytes32 entityKey;
    }

    uint8 internal constant OP_CREATE = 1;
    uint8 internal constant OP_PATCH = 2;
    uint8 internal constant OP_EXTEND = 3;
    uint8 internal constant OP_TRANSFER = 4;
    uint8 internal constant OP_DELETE = 5;

    uint8 internal constant TYPE_TOMBSTONE = 0;
    uint8 internal constant TYPE_BOOL = 1;
    uint8 internal constant TYPE_I32 = 2;
    uint8 internal constant TYPE_U64 = 3;
    uint8 internal constant TYPE_U256 = 4;
    uint8 internal constant TYPE_DEC = 5;
    uint8 internal constant TYPE_BYTES32 = 6;
    uint8 internal constant TYPE_BYTES = 7;
    uint8 internal constant TYPE_STR = 8;
    uint8 internal constant TYPE_ADDR = 9;
    uint8 internal constant TYPE_KEY = 10;
    uint8 internal constant INDEXED_FLAG = 0x80;

    uint8 internal constant FLAG_READONLY = 0x01;
    uint8 internal constant FLAG_PERMISSIONLESS_EXTENSION = 0x02;

    uint256 public constant MAX_ATTRIBUTES = 32;
    uint256 public constant MAX_STRING_BYTES = 128;
    uint256 public constant MAX_BYTES_LENGTH = 128 * 1024;
    /// @notice The longest an entity may live, in blocks, from the block the operation lands in.
    uint64 public constant MAX_LIFETIME = 7_884_000;

    // -----------------------------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------------------------

    event EntityCreated(
        bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags
    );
    event EntityPatched(bytes32 indexed entityKey, address indexed owner);
    event ExpiryExtended(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt);
    event OwnershipTransferred(
        bytes32 indexed entityKey, address indexed previousOwner, address indexed newOwner
    );
    event EntityDeleted(bytes32 indexed entityKey, address indexed owner);

    /// @notice Dev-only. Carries the attributes of a create, or the mutations of a patch, so the
    ///         devnet indexer can rebuild entity contents from logs alone. Emitted right after
    ///         the `EntityCreated` / `EntityPatched` event of the same operation. The real engine
    ///         emits nothing like it.
    event DevAttributes(bytes32 indexed entityKey, Attribute[] attributes);

    // -----------------------------------------------------------------------------------------
    // Errors (the specification's)
    // -----------------------------------------------------------------------------------------

    error EmptyBatch();
    error InvalidOpType(uint8 operation);
    error NonCanonicalOperationData(uint8 operation);
    error AttributesNotSorted();
    error TooManyAttributes(uint256 count, uint256 maxCount);
    error EmptyMutations(bytes32 entityKey);
    error TombstoneInCreate(bytes32 name);
    error TombstoneValueNotEmpty(bytes32 name);
    error SystemAttributeNotWritable(bytes32 name);
    error InvalidValueType(bytes32 name, uint8 typeId);
    error Ident32Empty();
    error Ident32InvalidByte(uint256 position, bytes1 value);
    error EntityNotFound(bytes32 entityKey);
    error EntityExpired(bytes32 entityKey, uint64 expiresAt);
    error NotOwner(bytes32 entityKey, address caller, address owner);
    error ReadOnlyEntity(bytes32 entityKey);
    error ReservedCreationFlags(uint8 creationFlags);
    error ExpiryDeadOnArrival(uint64 target, uint64 currentBlock);
    error ExpiryBeyondMaxLifetime(uint64 target, uint64 currentBlock, uint64 maxLifetime);
    error ExpiryNotExtended(bytes32 entityKey, uint64 newExpiresAt, uint64 currentExpiresAt);
    error TransferToZeroAddress(bytes32 entityKey);
    error TransferToSelf(bytes32 entityKey);

    // -----------------------------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------------------------

    struct Record {
        address owner;
        uint64 expiresAt;
        uint8 flags;
        bool live;
        uint16 attributeCount;
    }

    mapping(bytes32 entityKey => Record) private _records;
    mapping(bytes32 entityKey => mapping(bytes32 name => bool)) private _hasAttribute;

    /// @notice How many entities an account has created: the nonce its next create will use.
    mapping(address owner => uint64) public entityNonce;

    // -----------------------------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------------------------

    /// @notice Applies a batch of operations atomically, in order.
    /// @return keys The key each operation touched (for a create, the key it minted).
    function execute(Operation[] calldata ops) external returns (bytes32[] memory keys) {
        if (ops.length == 0) revert EmptyBatch();
        keys = new bytes32[](ops.length);
        for (uint256 i = 0; i < ops.length; i++) {
            uint8 tag = ops[i].operation;
            bytes calldata data = ops[i].operationData;
            if (tag == OP_CREATE) keys[i] = _create(data);
            else if (tag == OP_PATCH) keys[i] = _patch(data);
            else if (tag == OP_EXTEND) keys[i] = _extend(data);
            else if (tag == OP_TRANSFER) keys[i] = _transfer(data);
            else if (tag == OP_DELETE) keys[i] = _delete(data);
            else revert InvalidOpType(tag);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Dev views (not part of the real engine)
    // -----------------------------------------------------------------------------------------

    /// @notice Dev-only: the engine-side record of an entity.
    function devRecord(bytes32 entityKey) external view returns (Record memory) {
        return _records[entityKey];
    }

    // -----------------------------------------------------------------------------------------
    // Operations
    // -----------------------------------------------------------------------------------------

    function _create(bytes calldata data) private returns (bytes32 entityKey) {
        CreateOp memory op;
        try this.decodeCreate(data) returns (CreateOp memory decoded) {
            op = decoded;
        } catch {
            revert NonCanonicalOperationData(OP_CREATE);
        }
        if (keccak256(abi.encode(op)) != keccak256(data)) revert NonCanonicalOperationData(OP_CREATE);

        if ((op.creationFlags & ~(FLAG_READONLY | FLAG_PERMISSIONLESS_EXTENSION)) != 0) {
            revert ReservedCreationFlags(op.creationFlags);
        }
        _validateAttributes(op.attributes, false);
        uint64 expiresAt = _resolveExpiry(op.expiresAt, op.minLifetime);

        uint64 nonce = entityNonce[msg.sender]++;
        entityKey = keccak256(abi.encodePacked(block.chainid, address(this), msg.sender, nonce, op.salt));

        Record storage record = _records[entityKey];
        record.owner = msg.sender;
        record.expiresAt = expiresAt;
        record.flags = op.creationFlags;
        record.live = true;
        record.attributeCount = uint16(op.attributes.length);
        for (uint256 i = 0; i < op.attributes.length; i++) {
            _hasAttribute[entityKey][op.attributes[i].name] = true;
        }

        emit EntityCreated(entityKey, msg.sender, expiresAt, op.creationFlags);
        emit DevAttributes(entityKey, op.attributes);
    }

    function _patch(bytes calldata data) private returns (bytes32 entityKey) {
        PatchOp memory op;
        try this.decodePatch(data) returns (PatchOp memory decoded) {
            op = decoded;
        } catch {
            revert NonCanonicalOperationData(OP_PATCH);
        }
        if (keccak256(abi.encode(op)) != keccak256(data)) revert NonCanonicalOperationData(OP_PATCH);
        entityKey = op.entityKey;

        if (op.mutations.length == 0) revert EmptyMutations(entityKey);
        _validateAttributes(op.mutations, true);

        Record storage record = _liveRecord(entityKey);
        if (record.owner != msg.sender) revert NotOwner(entityKey, msg.sender, record.owner);
        if ((record.flags & FLAG_READONLY) != 0) revert ReadOnlyEntity(entityKey);

        uint256 count = record.attributeCount;
        mapping(bytes32 => bool) storage has = _hasAttribute[entityKey];
        for (uint256 i = 0; i < op.mutations.length; i++) {
            bytes32 name = op.mutations[i].name;
            if (op.mutations[i].typeId == TYPE_TOMBSTONE) {
                if (has[name]) {
                    has[name] = false;
                    count--;
                }
            } else if (!has[name]) {
                has[name] = true;
                count++;
            }
        }
        if (count > MAX_ATTRIBUTES) revert TooManyAttributes(count, MAX_ATTRIBUTES);
        record.attributeCount = uint16(count);

        emit EntityPatched(entityKey, record.owner);
        emit DevAttributes(entityKey, op.mutations);
    }

    function _extend(bytes calldata data) private returns (bytes32 entityKey) {
        ExtendOp memory op;
        try this.decodeExtend(data) returns (ExtendOp memory decoded) {
            op = decoded;
        } catch {
            revert NonCanonicalOperationData(OP_EXTEND);
        }
        if (keccak256(abi.encode(op)) != keccak256(data)) revert NonCanonicalOperationData(OP_EXTEND);
        entityKey = op.entityKey;

        Record storage record = _liveRecord(entityKey);
        if ((record.flags & FLAG_PERMISSIONLESS_EXTENSION) == 0 && record.owner != msg.sender) {
            revert NotOwner(entityKey, msg.sender, record.owner);
        }
        uint64 expiresAt = _resolveExpiry(op.expiresAt, op.minLifetime);
        if (expiresAt < record.expiresAt) revert ExpiryNotExtended(entityKey, expiresAt, record.expiresAt);
        record.expiresAt = expiresAt;

        emit ExpiryExtended(entityKey, record.owner, expiresAt);
    }

    function _transfer(bytes calldata data) private returns (bytes32 entityKey) {
        TransferOp memory op;
        try this.decodeTransfer(data) returns (TransferOp memory decoded) {
            op = decoded;
        } catch {
            revert NonCanonicalOperationData(OP_TRANSFER);
        }
        if (keccak256(abi.encode(op)) != keccak256(data)) revert NonCanonicalOperationData(OP_TRANSFER);
        entityKey = op.entityKey;

        Record storage record = _liveRecord(entityKey);
        address previousOwner = record.owner;
        if (previousOwner != msg.sender) revert NotOwner(entityKey, msg.sender, previousOwner);
        if (op.newOwner == address(0)) revert TransferToZeroAddress(entityKey);
        if (op.newOwner == previousOwner) revert TransferToSelf(entityKey);
        record.owner = op.newOwner;

        emit OwnershipTransferred(entityKey, previousOwner, op.newOwner);
    }

    function _delete(bytes calldata data) private returns (bytes32 entityKey) {
        DeleteOp memory op;
        try this.decodeDelete(data) returns (DeleteOp memory decoded) {
            op = decoded;
        } catch {
            revert NonCanonicalOperationData(OP_DELETE);
        }
        if (keccak256(abi.encode(op)) != keccak256(data)) revert NonCanonicalOperationData(OP_DELETE);
        entityKey = op.entityKey;

        Record storage record = _liveRecord(entityKey);
        address owner = record.owner;
        if (owner != msg.sender) revert NotOwner(entityKey, msg.sender, owner);
        record.live = false;

        emit EntityDeleted(entityKey, owner);
    }

    // -----------------------------------------------------------------------------------------
    // Payload decoders. External so a malformed payload can be caught and reported as
    // NonCanonicalOperationData instead of surfacing as a bare revert.
    // -----------------------------------------------------------------------------------------

    function decodeCreate(bytes calldata data) external pure returns (CreateOp memory) {
        return abi.decode(data, (CreateOp));
    }

    function decodePatch(bytes calldata data) external pure returns (PatchOp memory) {
        return abi.decode(data, (PatchOp));
    }

    function decodeExtend(bytes calldata data) external pure returns (ExtendOp memory) {
        return abi.decode(data, (ExtendOp));
    }

    function decodeTransfer(bytes calldata data) external pure returns (TransferOp memory) {
        return abi.decode(data, (TransferOp));
    }

    function decodeDelete(bytes calldata data) external pure returns (DeleteOp memory) {
        return abi.decode(data, (DeleteOp));
    }

    // -----------------------------------------------------------------------------------------
    // Rules
    // -----------------------------------------------------------------------------------------

    /// @dev An entity is live while it exists and the current block is before its expiry.
    function _liveRecord(bytes32 entityKey) private view returns (Record storage record) {
        record = _records[entityKey];
        if (!record.live) revert EntityNotFound(entityKey);
        if (record.expiresAt <= block.number) revert EntityExpired(entityKey, record.expiresAt);
    }

    /// @dev expiry = max(expiresAt, currentBlock + minLifetime); it must land after the current
    ///      block and at most MAX_LIFETIME blocks past it.
    function _resolveExpiry(uint64 expiresAt, uint64 minLifetime) private view returns (uint64 target) {
        uint64 current = uint64(block.number);
        uint256 relative = minLifetime == 0 ? 0 : uint256(current) + uint256(minLifetime);
        uint256 resolved = relative > expiresAt ? relative : expiresAt;
        if (resolved > type(uint64).max) {
            revert ExpiryBeyondMaxLifetime(type(uint64).max, current, MAX_LIFETIME);
        }
        target = uint64(resolved);
        if (target <= current) revert ExpiryDeadOnArrival(target, current);
        if (target > current + MAX_LIFETIME) revert ExpiryBeyondMaxLifetime(target, current, MAX_LIFETIME);
    }

    function _validateAttributes(Attribute[] memory attributes, bool isPatch) private pure {
        if (attributes.length > MAX_ATTRIBUTES) revert TooManyAttributes(attributes.length, MAX_ATTRIBUTES);
        bytes32 previous;
        for (uint256 i = 0; i < attributes.length; i++) {
            Attribute memory attribute = attributes[i];
            _validateName(attribute.name);
            // Strictly ascending by name: sorted, and each name at most once.
            if (i != 0 && uint256(attribute.name) <= uint256(previous)) revert AttributesNotSorted();
            previous = attribute.name;
            _validateValue(attribute, isPatch);
        }
    }

    /// @dev A name is ASCII, left-aligned and zero-padded: a letter, then letters, digits,
    ///      `.`, `-` or `_`. Names starting with `$` belong to the engine.
    function _validateName(bytes32 name) private pure {
        bytes1 first = name[0];
        if (first == 0) revert Ident32Empty();
        if (first == "$") revert SystemAttributeNotWritable(name);
        if (!_isLetter(first)) revert Ident32InvalidByte(0, first);
        bool ended;
        for (uint256 i = 1; i < 32; i++) {
            bytes1 char = name[i];
            if (ended) {
                // Padding must be all zeros: a byte after the terminator is not part of a name.
                if (char != 0) revert Ident32InvalidByte(i, char);
            } else if (char == 0) {
                ended = true;
            } else if (!(_isLetter(char) || (char >= "0" && char <= "9") || char == "." || char == "-"
                        || char == "_")) {
                revert Ident32InvalidByte(i, char);
            }
        }
    }

    function _isLetter(bytes1 char) private pure returns (bool) {
        return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z");
    }

    function _validateValue(Attribute memory attribute, bool isPatch) private pure {
        uint8 typeId = attribute.typeId;
        bytes memory value = attribute.value;

        if (typeId == TYPE_TOMBSTONE) {
            if (!isPatch) revert TombstoneInCreate(attribute.name);
            if (value.length != 0) revert TombstoneValueNotEmpty(attribute.name);
            return;
        }

        uint8 base = typeId & ~INDEXED_FLAG;
        bool isIndexed = (typeId & INDEXED_FLAG) != 0;

        if (base == TYPE_BYTES) {
            // Stored, never indexed.
            if (isIndexed || value.length > MAX_BYTES_LENGTH) {
                revert InvalidValueType(attribute.name, typeId);
            }
            return;
        }
        if (base == TYPE_STR) {
            if (value.length > MAX_STRING_BYTES) revert InvalidValueType(attribute.name, typeId);
            return;
        }
        if (base == TYPE_TOMBSTONE || base > TYPE_KEY) revert InvalidValueType(attribute.name, typeId);

        // Every remaining type is one 32-byte word, encoded as Solidity would.
        if (value.length != 32) revert InvalidValueType(attribute.name, typeId);
        uint256 word = uint256(bytes32(value));
        bool fits = true;
        if (base == TYPE_BOOL) fits = word <= 1;
        else if (base == TYPE_I32) fits = int256(word) == int256(int32(int256(word)));
        else if (base == TYPE_U64) fits = word <= type(uint64).max;
        else if (base == TYPE_ADDR) fits = word <= type(uint160).max;
        if (!fits) revert InvalidValueType(attribute.name, typeId);
    }
}
