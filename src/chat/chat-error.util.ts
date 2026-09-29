export type ChatErrorCode = 'RATE_LIMIT' | 'AUTH_ERROR' | 'UPSTREAM_ERROR' | 'UNKNOWN';

export interface ClassifiedError {
  code: ChatErrorCode;
  message: string;
}

/**
 * Turns whatever the Gemini SDK / Supabase client throws into a stable code the frontend
 * can branch on, instead of a generic "something went wrong" for every failure.
 *
 * The Gemini SDK's error shape is inconsistent and inconsistently nested — generateContent
 * and generateContentStream wrap the underlying Google API error differently (sometimes as a
 * JSON string inside `.message`, sometimes double-JSON-encoded inside that). Rather than
 * chase an exact path, we just search the whole stringified error for the marker substrings
 * Google's API actually uses ("RESOURCE_EXHAUSTED", "API_KEY_INVALID", etc.) — those appear
 * verbatim regardless of nesting depth.
 */
export function classifyError(err: unknown): ClassifiedError {
  const status = (err as any)?.status;
  const text = `${(err as any)?.message ?? ''} ${String(err)}`;

  if (status === 429 || text.includes('RESOURCE_EXHAUSTED')) {
    return {
      code: 'RATE_LIMIT',
      message: "We've hit our AI usage limit for now — please try again in a minute or two.",
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    text.includes('API_KEY_INVALID') ||
    text.includes('UNAUTHENTICATED') ||
    text.includes('PERMISSION_DENIED')
  ) {
    return {
      code: 'AUTH_ERROR',
      message: 'The assistant is misconfigured (invalid API key). Please contact the site owner.',
    };
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      code: 'UPSTREAM_ERROR',
      message: "Our AI provider is having issues right now — please try again shortly.",
    };
  }
  // The SDK's own stream parser throws this (no HTTP status attached) when the connection
  // to Gemini gets cut off mid-response — observed in practice to be transient, same as the
  // other overload symptoms above.
  if (text.includes('Incomplete JSON segment')) {
    return {
      code: 'UPSTREAM_ERROR',
      message: "Our AI provider is having issues right now — please try again shortly.",
    };
  }
  return {
    code: 'UNKNOWN',
    message: 'Something went wrong on our end. Please try again.',
  };
}
