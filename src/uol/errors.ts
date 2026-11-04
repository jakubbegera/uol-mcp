/**
 * Error raised for any non-success UOL response. [message] is written for the
 * model and the user: it says what went wrong and, where it helps, what to do.
 */
export class UolApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** UOL error code (`0001`–`0010`) or `validation` / `rate_limited` / `network`. */
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'UolApiError';
  }
}

interface UolErrorBody {
  status?: string;
  code?: string;
  message?: string;
  developerMessage?: string;
  errors?: { resource?: string; field?: string; code?: string }[];
}

const CODE_HINTS: Record<string, string> = {
  '0001': 'The Authorization header is missing.',
  '0002':
    'UOL rejected the credentials. Check UOL_EMAIL and UOL_TOKEN, and that the user has the "REST API" permission. ' +
    'The same code is returned when the user lacks access to this particular resource.',
  '0003': 'Unknown tenant — check UOL_TENANT.',
  '0004': 'Check the id — the search tools return valid ids.',
  '0005': 'The record cannot be deleted because other records depend on it.',
  '0010': 'UOL internal error. Try again later; if it persists, contact api@uol.cz.',
};

export function errorFromResponse(status: number, bodyText: string): UolApiError {
  let body: UolErrorBody | undefined;
  try {
    body = JSON.parse(bodyText) as UolErrorBody;
  } catch {
    body = undefined;
  }

  if (status === 429) {
    return new UolApiError(
      'UOL rate limit exceeded (30 requests / 10 s, receivables 10 / 10 s); the API blocks further calls for 30 seconds. Wait and retry.',
      status,
      'rate_limited',
    );
  }

  const fieldErrors = body?.errors?.filter((e) => e.field || e.code) ?? [];
  if (fieldErrors.length > 0) {
    const parts = fieldErrors.map((e) => [e.field, e.code].filter(Boolean).join(': '));
    return new UolApiError(
      `${body?.message ?? 'Validation failed'} — ${parts.join('; ')}`,
      status,
      'validation',
      fieldErrors,
    );
  }

  const code = body?.code ?? String(status);
  const hint = CODE_HINTS[code];
  const message = [body?.message, hint].filter(Boolean).join(' ') || `UOL answered HTTP ${status}.`;
  return new UolApiError(message, status, code, body?.developerMessage);
}
