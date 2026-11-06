/**
 * Runs a parsed query over the devnet's entities.
 *
 * Semantics, each checked against the Rabdi testnet:
 * - A condition only sees *indexed* attributes: comparing, `EXISTS` and `TYPEOF` on an
 *   attribute stored without an index match nothing.
 * - A comparison also asserts the type: `score = i32(4)` does not match a `score` stored as dec.
 *   The one exception is `key` and `bytes32`, which the node treats as the same type.
 * - A sort reads an attribute whether or not it is indexed. An entity without it (or with it
 *   stored as another type) sorts below every value: first with ASC, last with DESC.
 */
import { hexToBytes } from 'viem';
import { type Comparable, type StoredEntity, type TypeTag, comparableOf, compareValues } from '../model';
import { type ComparisonOperator, type Condition, type OrderBy, SYSTEM_FIELD_TYPES, canonicalType } from './parser';

function satisfies(order: number, operator: ComparisonOperator): boolean {
  switch (operator) {
    case '=':
      return order === 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
  }
}

const sameType = (a: TypeTag, b: TypeTag) => canonicalType(a) === canonicalType(b);

function systemValue(entity: StoredEntity, name: string): Comparable {
  switch (name) {
    case '$key':
      return { type: 'key', bytes: hexToBytes(entity.key) };
    case '$owner':
      return { type: 'addr', bytes: hexToBytes(entity.owner) };
    case '$creator':
      return { type: 'addr', bytes: hexToBytes(entity.creator) };
    default:
      return { type: 'u64', num: entity.expiresAt };
  }
}

/** The value a condition sees for `name`: an entity field, or an indexed attribute. */
function filterValue(entity: StoredEntity, name: string): Comparable | undefined {
  if (SYSTEM_FIELD_TYPES[name] !== undefined) return systemValue(entity, name);
  const attribute = entity.attributes.get(name);
  return attribute?.indexed ? comparableOf(attribute) : undefined;
}

/** The value a sort sees for `name` as `type`: indexed or not, but only with that type. */
function sortValue(entity: StoredEntity, name: string, type: TypeTag): Comparable | undefined {
  if (SYSTEM_FIELD_TYPES[name] !== undefined) return systemValue(entity, name);
  const attribute = entity.attributes.get(name);
  return attribute !== undefined && sameType(attribute.type, type) ? comparableOf(attribute) : undefined;
}

export function matches(condition: Condition, entity: StoredEntity): boolean {
  switch (condition.kind) {
    case 'all':
      return true;
    case 'and':
      return condition.conditions.every((sub) => matches(sub, entity));
    case 'or':
      return condition.conditions.some((sub) => matches(sub, entity));
    case 'exists':
      return filterValue(entity, condition.name) !== undefined;
    case 'typeOf': {
      const value = filterValue(entity, condition.name);
      return value !== undefined && sameType(value.type, condition.tag);
    }
    case 'comparison': {
      const value = filterValue(entity, condition.name);
      if (value === undefined || !sameType(value.type, condition.value.type)) return false;
      return satisfies(compareValues(value, condition.value), condition.operator);
    }
    case 'between': {
      const value = filterValue(entity, condition.name);
      if (value === undefined || !sameType(value.type, condition.low.type)) return false;
      return compareValues(value, condition.low) >= 0 && compareValues(value, condition.high) <= 0;
    }
    case 'startsWith': {
      const value = filterValue(entity, condition.name);
      if (value === undefined || value.type !== 'str' || value.bytes === undefined) return false;
      const prefix = condition.prefix;
      if (prefix.length > value.bytes.length) return false;
      for (let i = 0; i < prefix.length; i++) {
        if (value.bytes[i] !== prefix[i]) return false;
      }
      return true;
    }
  }
}

/**
 * Orders the matches. Without ORDER BY the real node returns "its own order", which is not
 * specified (it is not key order); the devnet uses creation order, which is also what ties in
 * an ORDER BY fall back to.
 */
export function sortEntities(entities: StoredEntity[], orderBy: OrderBy | undefined): StoredEntity[] {
  const inCreationOrder = [...entities].sort((a, b) => a.sequence - b.sequence);
  if (orderBy === undefined) return inCreationOrder;

  const keyed = inCreationOrder.map((entity) => ({ entity, value: sortValue(entity, orderBy.name, orderBy.type) }));
  const sign = orderBy.direction === 'asc' ? 1 : -1;
  // Array.prototype.sort is stable, so ties keep the creation order established above.
  keyed.sort((a, b) => {
    if (a.value === undefined || b.value === undefined) {
      if (a.value === undefined && b.value === undefined) return 0;
      // "Below every value": first when ascending, last when descending.
      return (a.value === undefined ? -1 : 1) * sign;
    }
    return compareValues(a.value, b.value) * sign;
  });
  return keyed.map(({ entity }) => entity);
}
