use serde_json::{json, Value};
use tiny_http::{Header, Response, StatusCode};

pub(super) fn respond_error(request: tiny_http::Request, status: u16, message: &str) {
    respond_json(request, status, json!({ "ok": false, "error": message }));
}

pub(super) fn respond_options(request: tiny_http::Request) {
    let mut response = Response::empty(StatusCode(204));
    for header in cors_headers() {
        response.add_header(header);
    }
    response.add_header(Header::from_bytes("Access-Control-Max-Age", "600").unwrap());
    let _ = request.respond(response);
}

pub(super) fn respond_json(request: tiny_http::Request, status: u16, body: Value) {
    let mut response = Response::from_string(body.to_string()).with_status_code(StatusCode(status));
    for header in cors_headers() {
        response.add_header(header);
    }
    let _ = request.respond(response);
}

pub(super) fn split_url(url: &str) -> (String, &str) {
    match url.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => (url.to_string(), ""),
    }
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
        Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap(),
        Header::from_bytes(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-LLM-Wiki-Token",
        )
        .unwrap(),
        Header::from_bytes("Content-Type", "application/json").unwrap(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_url_separates_path_and_query() {
        let (path, query) = split_url("/api/v1/projects/current/files?path=wiki%2Findex.md");
        assert_eq!(path, "/api/v1/projects/current/files");
        assert_eq!(query, "path=wiki%2Findex.md");
    }

    #[test]
    fn split_url_returns_empty_query_when_missing() {
        let (path, query) = split_url("/health");
        assert_eq!(path, "/health");
        assert_eq!(query, "");
    }

    #[test]
    fn cors_headers_include_json_and_cors_defaults() {
        let headers = cors_headers();
        let pairs: Vec<(String, String)> = headers
            .iter()
            .map(|header| {
                (
                    header.field.as_str().to_string(),
                    header.value.as_str().to_string(),
                )
            })
            .collect();

        assert!(pairs
            .iter()
            .any(|(k, v)| k == "Access-Control-Allow-Origin" && v == "*"));
        assert!(pairs
            .iter()
            .any(|(k, v)| k == "Access-Control-Allow-Methods" && v == "GET, POST, OPTIONS"));
        assert!(pairs
            .iter()
            .any(|(k, v)| k == "Content-Type" && v == "application/json"));
    }
}
