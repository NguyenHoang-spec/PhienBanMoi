// --- AI Client Service ---

import { GoogleGenAI } from "@google/genai";
import { AppSettings } from "../types";

// The infinite retry fetch override has been removed to rely on geminiService.ts's exponential backoff retry logic.

export const getAiClient = (settings: AppSettings) => {
  let apiKey: string = "";
  let source = "SYSTEM";
  
  // 1. Kiểm tra nếu dùng Proxy
  if (settings.useProxy && settings.proxyKey) {
    apiKey = settings.proxyKey;
    source = "PROXY";
  } 

  // Fallback nếu không có key nào
  if (!apiKey) {
    apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || (import.meta as any).env?.VITE_GEMINI_API_KEY || "";
    source = "SYSTEM_ENV";
  }
  
  console.log(`%c[AI Client] 🔑 Sử dụng key từ: ${source}`, "color: #10b981; font-weight: bold;");

  // Khởi tạo SDK với Key đã chọn
  let genAIConfig: any = { apiKey };

  if (settings.useProxy && settings.proxyUrl) {
    // We MUST pass the actual apiKey here so the SDK includes it in the headers
    // If we pass "PROXY_MODE", the proxy server will receive "PROXY_MODE" as the key and reject it.
    genAIConfig.apiKey = apiKey || "PROXY_MODE";
    
    // Clean the proxy URL robustly
    // Handle cases where user pastes the full endpoint URL or trailing slashes/versions
    let cleanProxy = settings.proxyUrl.trim().replace(/\/+$/, '');
    cleanProxy = cleanProxy
      .replace(/\/v1beta\/models\/.*$/, '')
      .replace(/\/v1alpha\/models\/.*$/, '')
      .replace(/\/v1\/models\/.*$/, '')
      .replace(/\/v1beta$/, '')
      .replace(/\/v1alpha$/, '')
      .replace(/\/v1$/, '');
    
    // The new @google/genai SDK supports baseUrl directly
    genAIConfig.baseUrl = cleanProxy;
    
    const customFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        let urlStr = '';
        if (typeof input === 'string') {
          urlStr = input;
        } else if (input instanceof URL) {
          urlStr = input.href;
        } else if (input instanceof Request) {
          urlStr = input.url;
        }
        
        if (urlStr.includes(cleanProxy)) {
          return window.fetch(input, init);
        }
        
        const googleBase = 'https://generativelanguage.googleapis.com';
        if (urlStr.startsWith(googleBase)) {
          const newUrlStr = urlStr.replace(googleBase, cleanProxy);
          
          if (input instanceof Request) {
            // Reconstruct the request with the new URL
            const newReq = new Request(newUrlStr, input);
            return window.fetch(newReq, init);
          } else {
            return window.fetch(newUrlStr, init);
          }
        }
        
        return window.fetch(input, init);
      } catch (e) {
        console.error("[Proxy Fetch Error]", e);
        return window.fetch(input, init);
      }
    };

    // The new @google/genai SDK supports httpOptions
    genAIConfig.httpOptions = { fetch: customFetch };
    
    // We still keep the httpClient override for older versions
    genAIConfig.httpClient = { fetch: customFetch };
  }

  const genAI = new (GoogleGenAI as any)(genAIConfig);

  return genAI;
};
