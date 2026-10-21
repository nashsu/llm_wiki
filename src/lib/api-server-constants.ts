export const API_SERVER_PORT = parseInt(process.env.LLM_WIKI_API_PORT || '19828', 10)
export const API_SERVER_HOST = process.env.LLM_WIKI_API_HOST || '127.0.0.1'
export const API_SERVER_BASE_URL = `http://${API_SERVER_HOST}:${API_SERVER_PORT}`
export const API_SERVER_HEALTH_URL = `${API_SERVER_BASE_URL}/api/v1/health`
