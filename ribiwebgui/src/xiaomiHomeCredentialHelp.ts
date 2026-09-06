export const HOME_ASSISTANT_AUTHENTICATION_DOCS_URL = "https://www.home-assistant.io/docs/authentication/";
export const HOME_ASSISTANT_INSTALLATION_URL = "https://www.home-assistant.io/installation/";
export const HOME_ASSISTANT_XIAOMI_HOME_DOCS_URL = "https://www.home-assistant.io/integrations/xiaomi_miio/";

function homeAssistantUrl(baseUrl: string, pathname: string): string {
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function homeAssistantLoginUrl(baseUrl: string): string {
  return homeAssistantUrl(baseUrl, "/");
}

export function homeAssistantProfileUrl(baseUrl: string): string {
  return homeAssistantUrl(baseUrl, "/profile/security");
}
