/**
 * RFC 9457 (`application/problem+json`) error handling for the public API.
 * Every non-2xx response — validation failures, 404s, rate limiting, and
 * unexpected errors — is normalized to this shape by `registerErrorHandling`.
 */
export class ProblemError extends Error {
  readonly statusCode: number;
  readonly title: string;
  readonly type: string;
  readonly detail?: string;

  constructor(statusCode: number, title: string, detail?: string, type = "about:blank") {
    super(detail ?? title);
    this.statusCode = statusCode;
    this.title = title;
    this.type = type;
    this.detail = detail;
  }
}

export class NotFoundError extends ProblemError {
  constructor(detail: string) {
    super(404, "Not Found", detail);
  }
}

export class BadGatewayError extends ProblemError {
  constructor(detail: string) {
    super(502, "Bad Gateway", detail);
  }
}

export class ForbiddenError extends ProblemError {
  constructor(detail: string) {
    super(403, "Forbidden", detail);
  }
}

export class ConflictError extends ProblemError {
  constructor(detail: string) {
    super(409, "Conflict", detail);
  }
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  errors?: unknown;
}

export function problemBody(
  statusCode: number,
  title: string,
  instance: string,
  detail?: string,
  errors?: unknown,
): ProblemDetails {
  const body: ProblemDetails = { type: "about:blank", title, status: statusCode, instance };
  if (detail !== undefined) body.detail = detail;
  if (errors !== undefined) body.errors = errors;
  return body;
}
