export type ChatErrorCode = 'RATE_LIMIT' | 'AUTH_ERROR' | 'UPSTREAM_ERROR' | 'UNKNOWN';

export interface ClassifiedError {
  code: ChatErrorCode;
  message: string;
}

/**
 * Turns whatever the OpenAI SDK / Supabase client throws into a stable code the frontend
 * can branch on, instead of a generic "something went wrong" for every failure. OpenAI's
 * APIError subclasses carry the real HTTP status on `.status` (401 auth, 429 rate limit,
 * 5xx server), which is all we need here.
 */
export function classifyError(err: unknown): ClassifiedError {
  const status = (err as any)?.status;
  const text = `${(err as any)?.message ?? ''} ${String(err)}`;

  if (status === 429) {
    return {
      code: 'RATE_LIMIT',
      message: "We've hit our AI usage limit for now — please try again in a minute or two.",
    };
  }
  if (status === 401 || status === 403) {
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
  // Seen from streaming SDKs when the connection to the provider gets cut off mid-response —
  // no HTTP status attached, but observed in practice to be transient like the cases above.
  if (text.includes('Incomplete JSON segment') || text.includes('Premature close')) {
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
