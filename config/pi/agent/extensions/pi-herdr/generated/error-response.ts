/* eslint-disable */
/**
 * Generated from Herdr protocol 20, schema version 1.
 * Run `npm run generate` after updating Herdr. Do not edit by hand.
 */

export interface ErrorResponse {
  error: ErrorBody;
  id: string;
  [k: string]: unknown;
}
export interface ErrorBody {
  code: string;
  message: string;
  [k: string]: unknown;
}
