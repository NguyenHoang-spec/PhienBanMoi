// --- AI Client Service with Key Rotation ---

import { GoogleGenAI } from "@google/genai";
import { AppSettings } from "../types";

// SAFELY override fetch using defineProperty to handle "only a getter" environments
const originalFetch = window.fetch;

try {
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    enumerable: true,
    get: () => async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [resource, config] = args;
      const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : (resource as Request).url;
      
      // Các mã lỗi sẽ được tự động thử lại (429 là Too Many Requests)
      const RETRYABLE_STATUS_CODES = [401, 429, 502, 503, 504];
      const MAX_RETRIES = 3; // Thử lại tối đa 3 lần
      
      const performFetch = async (targetUrl: string, targetConfig: RequestInit | undefined, attempt: number = 0): Promise<Response> => {
        try {
          const response = await originalFetch(targetUrl, targetConfig);
          
          // NẾU BỊ LỖI 429 VÀ CHƯA QUÁ SỐ LẦN THỬ
          if (RETRYABLE_STATUS_CODES.includes(response.status) && attempt < MAX_RETRIES) {
            // Tính toán thời gian đợi: Lần 1 đợi 2s, lần 2 đợi 4s, lần 3 đợi 8s...
            const delay = response.status === 401 ? 2000 : Math.pow(2, attempt + 1) * 1000;
            console.log(`%c[Fetch Guard] 🔄 Thử lại lần ${attempt + 1}/${MAX_RETRIES} (Status: ${response.status}) sau ${delay}ms...`, "color: #f59e0b; font-weight: bold;");
            
            // Bắt hệ thống "ngủ" một lúc
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Gọi lại chính nó (Đệ quy)
            return performFetch(targetUrl, targetConfig, attempt + 1);
          }
          
          return response;
        } catch (error) {
          // Xử lý khi rớt mạng hoàn toàn
          if (attempt < MAX_RETRIES) {
            const delay = Math.pow(2, attempt + 1) * 1000;
            console.log(`%c[Fetch Guard] 🌐 Lỗi mạng, thử lại lần ${attempt + 1}/${MAX_RETRIES} sau ${delay}ms...`, "color: #ef4444; font-weight: bold;");
            await new Promise(resolve => setTimeout(resolve, delay));
            return performFetch(targetUrl, targetConfig, attempt + 1);
          }
          throw error;
        }
      };

      // Bắt đầu thực thi fetch đã được bảo vệ
      return performFetch(url, config);
    }
  });
} catch (e) {
  console.error("[AI Client] Không thể ghi đè fetch toàn cục.", e);
}

// Biến toàn cục để nhớ vị trí Key đang dùng (Round Robin)
let currentKeyIndex = 0;

export const getAiClient = (settings: AppSettings) => {
  let apiKey: string = "";
  let source = "SYSTEM";
  
  // 1. Kiểm tra nếu dùng Proxy
  if (settings.useProxy && settings.proxyKey) {
    apiKey = settings.proxyKey;
    source = "PROXY";
  } 
  // 2. Nếu không dùng Proxy, thực hiện xoay Key từ danh sách cá nhân
  else if (settings?.geminiApiKey && Array.isArray(settings.geminiApiKey)) {
    // Lọc bỏ các key rỗng hoặc key mặc định
    const keys = settings.geminiApiKey.filter(k => k && k.trim() !== "" && k !== "YOUR_API_KEY");
    
    if (keys.length > 0) {
        // Thuật toán xoay vòng (Round Robin)
        const index = currentKeyIndex % keys.length;
        apiKey = keys[index];
        source = `PERSONAL_LIST (Key #${index + 1})`;
        
        // Tăng index cho lần gọi tiếp theo
        currentKeyIndex = (index + 1) % keys.length;
    }
  }

  // Fallback nếu không có key nào
  if (!apiKey) {
    apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || import.meta.env.VITE_GEMINI_API_KEY || "";
    source = "SYSTEM_ENV";
  }
  
  console.log(`%c[AI Client] 🔑 Sử dụng key từ: ${source}`, "color: #10b981; font-weight: bold;");

  // Khởi tạo SDK với Key đã chọn
  let genAIConfig: any = { apiKey };

  if (settings.useProxy && settings.proxyUrl) {
    genAIConfig.apiKey = "PROXY_MODE";
    genAIConfig.httpClient = {
      fetch: (url: string, options: RequestInit) => {
        const cleanProxy = settings.proxyUrl!.trim().replace(/\/+$/, '').replace(/\/v1beta$|\/v1$/, '');
        
        if (url.includes(cleanProxy)) {
          return window.fetch(url, options);
        }
        
        const googleBase = 'https://generativelanguage.googleapis.com';
        if (url.startsWith(googleBase)) {
          const newUrl = url.replace(googleBase, cleanProxy);
          return window.fetch(newUrl, options);
        }
        
        return window.fetch(url, options);
      }
    };
  }

  const genAI = new (GoogleGenAI as any)(genAIConfig);

  return genAI;
};
