// --- AI Client Service with Key Rotation ---

import { GoogleGenAI } from "@google/genai";
import { AppSettings } from "../types";

// Biến đếm toàn cục để nhớ vị trí Key cuối cùng đã dùng
let currentKeyIndex = 0;

/**
 * Hàm lấy Client AI với cơ chế xoay Key
 */
export const getAiClient = (settings: AppSettings) => {
  let apiKey = "";
  
  // 1. Kiểm tra nếu dùng Proxy
  if (settings.useProxy && settings.proxyKey) {
    apiKey = settings.proxyKey;
  } 
  // 2. Nếu không dùng Proxy, thực hiện xoay Key từ danh sách cá nhân
  else if (settings.geminiApiKey && Array.isArray(settings.geminiApiKey)) {
    // Lọc bỏ các key trống hoặc key mặc định
    const validKeys = settings.geminiApiKey.filter(
      (k) => k && k.trim() !== "" && k !== "YOUR_API_KEY"
    );

    if (validKeys.length > 0) {
      // Thuật toán Round Robin: Lấy index hiện tại chia lấy dư cho tổng số key
      const index = currentKeyIndex % validKeys.length;
      apiKey = validKeys[index];
      
      // Log để debug (bạn có thể xóa khi deploy)
      console.log(`%c[AI Rotation] 🔄 Sử dụng Key #${index + 1}/${validKeys.length}`, "color: #38bdf8; font-weight: bold;");
      
      // Tăng index cho lần gọi tiếp theo
      currentKeyIndex = (index + 1) % validKeys.length;
    }
  }

  // 3. Fallback: Nếu không có key nào, lấy từ biến môi trường (cho AI Studio/Netlify)
  if (!apiKey) {
    // Ensure VITE_GEMINI_API_KEY is correctly exposed in your Vite config for Netlify/Vercel
    apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || import.meta.env.VITE_GEMINI_API_KEY || "DUMMY_KEY";
  }

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
