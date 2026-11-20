// OpenAI-style error `type` by status; `code` stays our own short code (wiki-llm/api.md).
function errorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  return status >= 500 ? "api_error" : "invalid_request_error";
}

export function apiError(status: number, message: string, code: string) {
  return { error: { message, type: errorType(status), code } };
}
