/**
 * A JSON-RPC error the devnet answers with. The codes for query rejections are the ones the
 * real node uses, which the SDK turns into a `QueryError` with a `kind`:
 *
 *   -32001 parse     the query does not parse
 *   -32002 type      a condition uses the wrong type for its operator
 *   -32003 literal   a value is invalid
 *   -32004 limits    a node budget was exceeded
 *   -32602           invalid params (for example a limit outside 1..100)
 *   -32603           internal error (the real node answers NOT with this: it is not implemented)
 */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export const PARSE = -32001;
export const TYPE = -32002;
export const LITERAL = -32003;
export const LIMITS = -32004;
export const INVALID_PARAMS = -32602;
export const INTERNAL = -32603;

/** A query rejection in the node's shape: the message repeated in `data` with the position. */
export function queryError(code: number, message: string, position: number): RpcError {
  return new RpcError(code, message, { message, position });
}
