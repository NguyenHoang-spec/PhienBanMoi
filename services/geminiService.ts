import { GoogleGenAI, Type, Schema, ThinkingLevel, GenerateContentResponse } from "@google/genai";
import { 
  GameGenre, 
  WorldSettings, 
  CharacterTraits, 
  StoryLength, 
  Turn, 
  AIStyle, 
  GameMechanics, 
  NSFWIntensity, 
  WritingStyle, 
  NSFWFocus, 
  AIResponseSchema,
  RegistryEntry,
  Ability
} from '../types';

// --- GLOBAL FETCH OVERRIDE FOR PROXY SUPPORT ---
// This intercepts all fetch requests and redirects them to the proxy if configured.
// This is necessary because the @google/genai SDK might bypass the custom httpClient in some cases.
const originalFetch = window.fetch;
try {
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    enumerable: true,
    get: () => async (resource: RequestInfo | URL, config?: RequestInit) => {
      const url = resource instanceof Request ? resource.url : resource.toString();
      
      const useProxy = localStorage.getItem('td_use_proxy') === 'true';
      const proxyUrl = localStorage.getItem('td_proxy_url');
      const proxyKey = localStorage.getItem('td_proxy_key');

      // Intercept requests going to Google's API
      if (useProxy && proxyUrl && url.includes('generativelanguage.googleapis.com')) {
        const cleanProxy = proxyUrl.trim().replace(/\/+$/, '').replace(/\/v1beta$|\/v1$/, '');
        const originalUrlObj = new URL(url);
        
        // Remove the dummy 'key' query parameter that the SDK adds
        originalUrlObj.searchParams.delete("key");
        
        const newUrl = `${cleanProxy}${originalUrlObj.pathname}${originalUrlObj.search}`;
        
        if (resource instanceof Request) {
          // Create a new Request object with the new URL but same properties
          // This preserves method, body, headers, etc.
          const newRequest = new Request(newUrl, resource);
          
          // Remove the dummy key headers that the SDK might add
          newRequest.headers.delete("x-goog-api-key");
          
          if (proxyKey) {
            newRequest.headers.set('Authorization', `Bearer ${proxyKey}`);
          }
          
          return originalFetch(newRequest);
        } else {
          const newConfig = { ...config };
          const headers = new Headers(newConfig.headers || {});
          
          // Remove the dummy key headers that the SDK might add
          headers.delete("x-goog-api-key");
          
          if (proxyKey) {
            headers.set('Authorization', `Bearer ${proxyKey}`);
          }
          newConfig.headers = headers;
          
          return originalFetch(newUrl, newConfig);
        }
      }

      return originalFetch(resource, config);
    }
  });
} catch (e) {
  console.error("[GeminiService] Không thể ghi đè fetch toàn cục", e);
}
// -----------------------------------------------

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const ARCHIVIST_MODEL = 'gemini-3.1-pro-preview';
const CHRONOS_MODEL = 'gemini-3.1-pro-preview';

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
];

class GeminiService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY || "DUMMY_KEY" });
    this.updateConfig();
  }

  public updateConfig() {
    const useProxy = localStorage.getItem('td_use_proxy') === 'true';
    const proxyUrl = localStorage.getItem('td_proxy_url');
    const proxyKey = localStorage.getItem('td_proxy_key');
    const proxyModel = localStorage.getItem('td_proxy_model');

    if (useProxy && proxyUrl) {
      // Initialize with Proxy. The global fetch override will handle the actual routing.
      this.ai = new (GoogleGenAI as any)({
        apiKey: "PROXY_MODE", // Dummy key to satisfy SDK
        httpClient: {
          fetch: (url: string, options: RequestInit) => {
            const cleanProxy = proxyUrl.trim().replace(/\/+$/, '').replace(/\/v1beta$|\/v1$/, '');
            
            // Nếu URL đã là proxy url rồi thì cứ thế gọi (sẽ đi qua global fetch override)
            if (url.includes(cleanProxy)) {
              return window.fetch(url, options);
            }
            
            // Nếu URL vẫn là của Google, thì thay thế bằng Proxy URL
            const googleBase = 'https://generativelanguage.googleapis.com';
            if (url.startsWith(googleBase)) {
              const newUrl = url.replace(googleBase, cleanProxy);
              return window.fetch(newUrl, options);
            }
            
            // Fallback
            return window.fetch(url, options);
          }
        }
      });
    } else {
      // Default initialization
      this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY || "DUMMY_KEY" });
    }
  }

  private getModel(taskType: 'main' | 'chronos' | 'archivist' | 'image', defaultModel: string): string {
    const useProxy = localStorage.getItem('td_use_proxy') === 'true';
    if (useProxy) {
      if (taskType === 'main') {
        return localStorage.getItem('td_proxy_model_main') || localStorage.getItem('td_proxy_model') || defaultModel;
      }
      if (taskType === 'chronos') {
        return localStorage.getItem('td_proxy_model_chronos') || localStorage.getItem('td_proxy_model_main') || localStorage.getItem('td_proxy_model') || defaultModel;
      }
      if (taskType === 'archivist') {
        return localStorage.getItem('td_proxy_model_archivist') || localStorage.getItem('td_proxy_model_main') || localStorage.getItem('td_proxy_model') || defaultModel;
      }
      if (taskType === 'image') {
        return localStorage.getItem('td_proxy_model_image') || defaultModel;
      }
    }
    return defaultModel;
  }

  // --- AI 0: CHRONOS (TIMEKEEPER) ---
  // Nhiệm vụ: Tính toán thời gian trôi qua dựa trên hành động
  async calculateTime(
    currentTime: string,
    userAction: string,
    genre: string,
    worldContext: string = "",
    recentNarrative: string = "",
    currentTimestamp: number = 0,
    upcomingEvents: string = "Không có sự kiện nào sắp tới.",
    thoughtProcess: string = ""
  ): Promise<{ timePassed: number, currentTime: string }> {
      const systemPrompt = `
      ROLE: Chronos (Time Logic Engine).
      GENRE: ${genre}
      CURRENT TIME: "${currentTime}"
      CURRENT TIMESTAMP: ${currentTimestamp} (minutes)
      UPCOMING EVENTS:
      ${upcomingEvents}
      WORLD CONTEXT: "${worldContext}"
      STORYTELLER'S THOUGHT PROCESS: "${thoughtProcess}"
      RECENT NARRATIVE: "${recentNarrative}"
      LOGIC RULES:
      LOGIC RULES:
       1. **TIME PROGRESSION (FORWARD ONLY)**: Time MUST ONLY increase. Never revert to a past time. Next Time = Current Time + Action Duration.
       2. **NARRATIVE TIME EXTRACTION (ABSOLUTE HIGHEST PRIORITY)**:
         - You MUST read the STORYTELLER'S THOUGHT PROCESS and the RECENT NARRATIVE first. They are the ultimate source of truth.
         - If the narrative explicitly describes or implies a specific time skip (e.g., "3 days later", "next morning", "years passed", "buổi trưa", "hoàng hôn"), you MUST calculate 'timePassed' so that the new 'currentTime' matches that narrative intent perfectly.
         - For example, if the story says "next morning", skip enough minutes to reach a logical morning time (e.g., 06:00 - 08:00) of the next day.
       3. **ACTION DURATION ANALYSIS & AUTO TIME-SKIP**:
         - Analyze the RECENT NARRATIVE and the INPUT ACTION.
         - **Sleeping/Resting**: If implying sleep, skip 6-10 hours to the next morning.
         - **Time Skip / Fast Forward**: If the action asks to "time skip...", "skip time", "tua nhanh", or "...đến khi có sự kiện mới":
           - Analyze the RECENT NARRATIVE to determine the next logical event or interesting part of the day. Skip a logical amount of time (e.g., skip to the next morning, or skip several hours/days if the character is waiting/traveling).
           - If a specific duration is mentioned (e.g., "10 years later"), skip exactly that amount.
         - **Active Actions** (traveling, cultivating, working): Skip logical duration (hours/days).
         - **Short Actions** (talking, attacking): Skip 1-15 minutes.
       4. **CALCULATION & REALISM**:
           - Calculate calendar changes logically (e.g., if Hour >= 24, increment Day and adjust Day of Week).
           - **CRITICAL: REALISTIC MINUTES**: Use odd, realistic numbers like 13h02, 19h07, 08h23.
       5. **FORMAT REQUIREMENT**: You MUST output 'currentTime' EXACTLY in this format:
           "[Thứ] - [Ngày]/[Tháng]/[Năm]/[Giờ] - [Buổi/Mùa]"
           Example: "Chủ Nhật - 15/08/1024/14:23 - Buổi chiều/Mùa thu"
       6. **INITIALIZATION**: If starting a new game (Current Time is empty or initializing), generate a logical starting time based on the World Context. Avoid generic dates like 01/01/1000.
       7. **SILENT EXECUTION**: Time calculation must remain strictly in the background.
       8. **"CRITICAL RULE FOR TIME: Never explicitly state the exact time or use clock formats (e.g., avoid writing 'It is currently 13:05' or 'At 2:00 PM'). Instead, seamlessly weave the time of day into the narrative through environmental storytelling. Show the passage of time by describing the position of the sun, the quality of light, the length of shadows, the weather, or the ambient atmosphere.
       9. **NO CLOCK PHRASES**: STRICTLY PROHIBITED from using phrases like "Đồng hồ chỉ...", "Bây giờ là...", "Lúc này là...", or writing out time in words like "mười giờ ba mươi phút". If you must imply time, use natural descriptions like "Mặt trời đã lên đến đỉnh đầu", "Bóng tối bắt đầu bao trùm", "Tiếng gà gáy báo hiệu bình minh"."
      
      INPUT ACTION: "${userAction}"
      
      OUTPUT JSON:
      {
        "timePassed": number (minutes),
        "currentTime": string (The new formatted time string)
      }
      `;

      const schema: Schema = {
          type: Type.OBJECT,
          properties: {
              timePassed: { type: Type.NUMBER },
              currentTime: { type: Type.STRING }
          },
          required: ["timePassed", "currentTime"]
      };

      try {
          const response = await this.ai.models.generateContent({
              model: this.getModel('chronos', CHRONOS_MODEL),
              contents: { role: 'user', parts: [{ text: "Calculate new time." }] },
              config: {
                  systemInstruction: systemPrompt,
                  responseMimeType: 'application/json',
                  responseSchema: schema,
                  temperature: 0.1, // Logic tuyệt đối
                  safetySettings: SAFETY_SETTINGS as any,
                  thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH }
              }
          });
          const text = response.text || "{}";
          return JSON.parse(text);
      } catch (e) {
          console.error("Chronos Error:", e);
          throw e;
      }
  }

  async calculateEconomy(
      currentCurrency: string,
      userPrompt: string,
      recentNarrative: string
  ): Promise<string> {
      const systemPrompt = `
      Bạn là Kế Toán (Treasurer AI). Nhiệm vụ của bạn là tính toán số tiền hiện tại của nhân vật dựa trên số tiền cũ và các diễn biến mới nhất.
      
      SỐ TIỀN HIỆN TẠI: "${currentCurrency || '0'}"
      
      QUY TẮC:
      1. Đọc kỹ hành động của người chơi và diễn biến truyện để xem có giao dịch tài chính nào không (nhặt được tiền, mua bán, bị cướp, được thưởng...).
      2. Nếu CÓ giao dịch: Cộng hoặc trừ số tiền tương ứng vào SỐ TIỀN HIỆN TẠI.
      3. Nếu KHÔNG CÓ giao dịch: Giữ nguyên SỐ TIỀN HIỆN TẠI.
      4. KHÔNG BAO GIỜ tự bịa ra giao dịch nếu không được nhắc đến.
      5. Giữ nguyên đơn vị tiền tệ (ví dụ: Vàng, Bạc, Đồng, VND, USD...).
      6. Nếu SỐ TIỀN HIỆN TẠI là "0" hoặc trống ở LƯỢT ĐẦU TIÊN, hãy tự tạo một số tiền khởi điểm hợp lý dựa trên bối cảnh (ví dụ: "100 Đồng", "50 Vàng").Đồng tiền phải phù hợp với bối cảnh thế giới(Nhật Bản - Yên ).
      
      TRẢ VỀ KẾT QUẢ DƯỚI DẠNG JSON:
      {
          "newCurrency": "Số tiền sau khi tính toán (kèm đơn vị)"
      }
      `;

      const schema: Schema = {
          type: Type.OBJECT,
          properties: {
              newCurrency: { type: Type.STRING, description: "Số tiền mới kèm đơn vị" }
          },
          required: ["newCurrency"]
      };

      try {
          const response = await this.ai.models.generateContent({
              model: this.getModel('chronos', CHRONOS_MODEL),
              contents: { role: 'user', parts: [{ text: `Diễn biến gần đây: ${recentNarrative}\nHành động của người chơi: ${userPrompt}` }] },
              config: {
                  systemInstruction: systemPrompt,
                  responseMimeType: 'application/json',
                  responseSchema: schema,
                  temperature: 0.1, // Logic tuyệt đối
                  safetySettings: SAFETY_SETTINGS as any,
                  thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
              }
          });
          const text = response.text || "{}";
          return JSON.parse(text).newCurrency || currentCurrency;
      } catch (e) {
          console.error("Treasurer Error:", e);
          throw e;
      }
  }

  // --- AI 1: THE STORYTELLER ---
  async generateTurn(
    sessionId: number,
    modelName: string,
    genre: GameGenre,
    heroName: string,
    gender: string,
    worldSettings: WorldSettings,
    userPrompt: string,
    history: Turn[],
    characterTraits: CharacterTraits,
    lengthMode: StoryLength,
    isNSFW: boolean,
    nsfwIntensity: NSFWIntensity,
    writingStyle: WritingStyle,
    nsfwFocus: NSFWFocus[],
    summary: string,
    pronounRules: string,
    aiStyle: AIStyle | undefined,
    mechanics: GameMechanics | undefined,
    memoryDepth: 'standard' | 'high' | undefined,
    attributeSchema?: string[], 
    currentCurrency?: string,
    // preCalculatedTime là thời gian đã được Chronos tính xong
    preCalculatedTime?: string,
    abilities?: Ability[]
  ): Promise<{ parsed: AIResponseSchema; raw: string; thoughtSignature?: string; isCutOff?: boolean }> {
    
    let nsfwBlock = "";
    if (isNSFW && nsfwIntensity === 'extreme') {
        nsfwBlock = `
      ⚠️ TRẠNG THÁI 1: CHẾ ĐỘ CỐT TRUYỆN THUẦN TÚY (KHI CHƯA CÓ LỆNH TÌNH DỤC RÕ RÀNG)
      - **QUY TẮC TỐI THƯỢNG**: Khi người chơi chưa chủ động nhập lệnh "làm tình", "cởi đồ", "hôn sâu", v.v., coi như chế độ NSFW đang TẮT. Viết như một tác phẩm văn học chính thống, nghiêm túc.
      - **CẤM ĐỘNG DỤC VÔ CỚ**: Nhân vật tuyệt đối KHÔNG ĐƯỢC tự nhiên "nứng", chảy nước, hay có suy nghĩ dâm đãng khi chỉ đang nói chuyện, đi dạo, hoặc chạm nhẹ. Phụ nữ ngoài đời có lý trí, công việc và cảm xúc bình thường.
      - **CẤM CHỦ ĐỘNG GẠ GẪM**: Dù là vợ hay người yêu, NPC không được vồ vập, đè người chơi ra, hay liếc mắt đưa tình lố lăng. Giữ đúng địa vị, sự kiêu ngạo và tự trọng của nhân vật.

      ⚠️ TRẠNG THÁI 2: EXTREME EROTICA (CHỈ KHI NGƯỜI CHƠI CHỦ ĐỘNG RA LỆNH LÀM TÌNH)
      - **PHONG CÁCH: SIÊU THỰC & ĐỜI THỰC (CINEMATIC REALISM)**:
         + **CẤM TUYỆT ĐỐI HENTAI/ANIME TROPES**: Không ahegao, không trợn mắt trắng dã, không ngất xỉu vì sướng, không rên rỉ ầm ĩ "hỏng mất", "chạm tử cung rồi", "sâu quá". Phụ nữ ngoài đời không cảm nhận được tử cung.
         + **TÂM LÝ & SINH LÝ THỰC TẾ (SLOW BURN)**: Mọi thứ phải bắt đầu chậm rãi. Vuốt ve, hôn sâu, cởi đồ từ từ. Không có chuyện vừa chạm vào đã ướt sũng hay bắn thành tia. Dịch tiết chỉ đủ bôi trơn. Cơ thể có mồ hôi, hơi thở dốc, sự mệt mỏi, sự ngượng ngùng chân thực.
         + **MIÊU TẢ GIẢI PHẪU HỌC (ANATOMY)**: Khi miêu tả cảnh nóng, dùng từ ngữ trực diện, trần trụi nhưng mang tính tả thực (Vú, Lồn, Cặc, Lỗ đít, Tinh dịch) thay vì ẩn dụ sến súa (hoa huyệt, gậy thịt). Miêu tả kết cấu da, nhiệt độ, nhịp đập, sự co thắt cơ vòng.
      - **LỜI THOẠI KHI ÂN ÁI (REALISTIC DIALOGUE)**:
         + Giữ nguyên 100% tính cách nhân vật. Một nữ hoàng kiêu ngạo sẽ không rên rỉ dâm đãng như kỹ nữ.
         + Lời thoại đứt quãng, thở dốc, gọi tên đối tác, rên khẽ trong cổ họng. TUYỆT ĐỐI KHÔNG gào thét giả tạo hay nói những câu dâm ô phi thực tế nếu không đúng bản chất nhân vật.
         + Sau khi xong việc (Aftercare): Vẫn tỉnh táo, ôm ấp, trò chuyện, lau mồ hôi. Không co giật hay mất ý thức.
      - FOCUS: ${nsfwFocus.join(', ') || "Action, Sensation"}.
      `;
    } else if (isNSFW) {
        nsfwBlock = "NSFW: SOFT/ROMANTIC. Focus on emotion and sensual descriptions.";
    } else {
        nsfwBlock = "NSFW MODE: OFF. Maintain strict PG-13 content. Focus on plot/emotion.";
    }

    // World Laws Block
    let worldLawsBlock = "";
    if (worldSettings.worldLaws && worldSettings.worldLaws.length > 0 && worldSettings.isWorldLawsEnabled !== false) {
        worldLawsBlock = `
      === [ABSOLUTE WORLD LAWS - LUẬT LỆ TUYỆT ĐỐI CỦA THẾ GIỚI] ===
      CẢNH BÁO: BẠN BẮT BUỘC PHẢI TUÂN THỦ NGHIÊM NGẶT CÁC LUẬT LỆ SAU ĐÂY TRONG MỌI TÌNH HUỐNG. 
      Bất kỳ hành động, lời nói, hay sự xuất hiện của NPC nào vi phạm các luật này đều bị coi là LỖI NGHIÊM TRỌNG:
      ${worldSettings.worldLaws.map((law, i) => `- Luật ${i + 1}: ${law}`).join('\n      ')}
      Nếu người chơi cố tình làm trái luật, hãy để thế giới phản ứng lại một cách hợp lý để bảo vệ luật lệ này.
      `;
    }

    const abilitiesBlock = abilities && abilities.length > 0 
      ? `\n      [NĂNG LỰC CỦA NHÂN VẬT CHÍNH]: Nhân vật chính hiện có các năng lực sau:\n${abilities.map((a, i) => `      ${i + 1}. ${a.name}: ${a.shortDescription}`).join('\n')}\n      BẮT BUỘC: Khi nhân vật hành động, chiến đấu hoặc giải quyết vấn đề, hãy dựa vào các năng lực này. KHÔNG ĐƯỢC tự bịa ra năng lực mà nhân vật chưa có.`
      : '';

    // System Instruction
    let systemInstruction = `
      ROLE: Storyteller & Game Master (Người Kể Chuyện & Quản Lý Hệ Thống).
      CTX: ${genre} | Hero: ${heroName} (${gender}) | World: ${worldSettings.worldContext}
      ${worldSettings.referenceContext ? `LORE: ${worldSettings.referenceContext.substring(0, 2000)}...` : ''}
      ${worldLawsBlock}
      ${abilitiesBlock}
      
      DATA INPUT:
      - PRE-CALCULATED TIME: "${preCalculatedTime || 'Unknown'}"
      - CURRENT WALLET: "${currentCurrency || '0'}"
      - SUMMARY OF PAST EVENTS: "${summary || 'Chưa có tóm tắt.'}"

      NHIỆM VỤ:
      1. Viết tiếp diễn biến câu chuyện (Narrative).
      2. Cập nhật Thời Gian (Dùng giá trị được cung cấp).
      3. Cập nhật Tiền bạc (Dùng giá trị được cung cấp).
      4. Quản lý Hành Trang (Inventory) và Chỉ Số (Stats).
      
      === [TIME UPDATE PROTOCOL (PASSIVE & SILENT)] ===
      1. **SOURCE OF TRUTH**: Time calculation is handled by an EXTERNAL AI (Chronos).
      2. **INSTRUCTION**: You will receive a specific command in the User Prompt (e.g., "[HỆ THỐNG THỜI GIAN]...").
      3. **ACTION**: You MUST update 'stats.currentTime' EXACTLY as the system requests in that command.
      4. **NARRATIVE CONSISTENCY (CRITICAL)**: Your generated narrative MUST strictly match the 'PRE-CALCULATED TIME' UNLESS the user explicitly requests to skip time (e.g., "chờ đến tối", "ngủ một giấc", "vài ngày sau"). If the user does NOT request a time skip, and the time is morning (e.g., 07:00 AM), you CANNOT describe stars, sunset, or night time. If the time is night, you CANNOT describe the morning sun. Hallucinating the wrong time of day is a critical failure.
      5. **GENERIC TIME SKIP (CRITICAL)**: If the user requests a generic skip (e.g., "tua đến sự kiện chính", "tua nhanh", "bỏ qua đoạn này") WITHOUT specifying how much time passes:
         - DO NOT invent a trivial event that happens 5 minutes later (e.g., someone knocking on the door, a sudden noise). This is a critical failure of the "skip" command.
         - You MUST force a SIGNIFICANT time jump (e.g., several hours, days, weeks, or even months) to reach a TRULY meaningful new event or plot point (e.g., arriving at a new continent, finishing a long training session, a tournament starting).
         - **VARY THE TIME OF DAY (CRITICAL)**: DO NOT always start the new scene in the morning (e.g., 07:00 AM). LLMs have a strong bias to start scenes at sunrise or "the next morning". Break this bias! Depending on the event, the new scene should happen at noon, late afternoon, dusk, or midnight (e.g., an assassination event should happen at 02:00 AM, a meeting at 14:00, arriving at a spooky town at dusk).
         - You MUST EXPLICITLY state this intended time gap AND the target time of day in your 'thoughtProcess' field (e.g., "Skipping 5 days to reach the capital, arriving at dusk", "Skipping 1 month for training, ending at midnight").
         - DO NOT explicitly write "Ba ngày sau..." or "Vài canh giờ trôi qua..." in the visible 'narrative' text. Make the transition feel seamless and silent in the story.
         - DO NOT make the event happen immediately (e.g., "Ngay lúc đó...") if it logically requires travel or waiting. Just describe the new scene as if the time has already passed.

      === [ECONOMY UPDATE PROTOCOL (PASSIVE & SILENT)] ===
      1. **SOURCE OF TRUTH**: Economy calculation is handled by an EXTERNAL AI (Treasurer).
      2. **INSTRUCTION**: Use the 'CURRENT WALLET' value provided above.
      3. **ACTION**: You MUST update 'stats.currency' EXACTLY to match 'CURRENT WALLET'. Do not do any math yourself.
      4. **SILENT EXECUTION**: Financial calculations must remain strictly in the background (JSON data). It is STRICTLY FORBIDDEN to explicitly mention exact account balances, checking wallets, or doing math in the narrative text. Do not write robotic phrases like "Your balance is now 500 Gold".

      === [TRAITS PROTOCOL] ===
      1. **SILENT EXECUTION (TRAITS/TALENTS)**: CRITICAL RULE FOR ALL TURNS: It is STRICTLY FORBIDDEN to explicitly list, name, or directly mention the character's "Traits" or "Talents" in the 'narrative' text. You MUST use the "Show, Don't Tell" principle. Demonstrate their traits naturally through actions, reflexes, or thoughts. For example: Instead of writing "Thanks to your 'Super Strength' trait...", write "Your muscles bulged as you effortlessly lifted the heavy boulder...".
      
      === [FORMATTING PROTOCOL] ===
      1. **DIALOGUE**: BẮT BUỘC bọc tất cả các câu thoại của nhân vật trong dấu ngoặc kép ("..."). KHÔNG dùng dấu ngoặc kép đơn ('...').
      2. **NEW LINE FOR DIALOGUE/THOUGHTS**: BẮT BUỘC: Mọi lời thoại hoặc suy nghĩ của nhân vật (dù dùng ngoặc kép "" hay nháy đơn '') đều phải được viết tách riêng thành một dòng mới. TUYỆT ĐỐI KHÔNG viết lời thoại nối tiếp ngay sau câu miêu tả trên cùng một dòng.
      3. **PARAGRAPHS (QUAN TRỌNG)**: BẮT BUỘC phải chia nhỏ văn bản thành nhiều đoạn ngắn (paragraphs) bằng cách xuống dòng (sử dụng ký tự \`\\n\\n\`). 
         - TUYỆT ĐỐI KHÔNG viết một cục văn bản dài liền mạch gây khó đọc. Phải làm cho văn bản thật THOÁNG.
         - Mỗi đoạn văn CHỈ ĐƯỢC PHÉP dài TỐI ĐA 2 CÂU. Hết 1 đến 2 câu là PHẢI XUỐNG DÒNG ngay lập tức.
         - Đặc biệt trong các cảnh miêu tả chi tiết (như cảnh nóng, chiến đấu), việc ngắt đoạn liên tục là bắt buộc để tạo nhịp điệu và dễ đọc.

      === [PRONOUN PROTOCOL] ===
      QUY TẮC XƯNG HÔ: ${pronounRules || "ADAPTIVE PRONOUNS (STRICTLY 2 MODES):\\n1. TU TIÊN / KIẾM HIỆP (Wuxia/Xianxia): Sử dụng xưng hô cổ trang đậm chất tu tiên: 'Ngươi - Ta', 'Tại hạ', 'Đạo hữu', 'Tiền bối', 'Vãn bối', 'Bổn tọa'.\\n2. ANIME / MANGA: BẮT BUỘC giữ văn hóa xưng hô Nhật Bản. KHÔNG DÙNG 'anh', 'chị', 'chú', 'bác' thuần Việt (CẤM viết 'chị Fern', 'chú Stark'). BẮT BUỘC dùng hậu tố: '-san', '-kun', '-chan', '-sama', 'Sensei', 'Senpai' (VD: 'Fern-san', 'Frieren-sama'). Nếu gọi anh/chị, dùng 'Onii-chan', 'Onee-san'. Xưng hô cơ bản: 'Cậu - Tớ', 'Tôi - Cậu', hoặc xưng bằng Tên. Chú ý tuổi tác (VD: Player 6 tuổi thì NPC gọi là [Tên]-chan/kun)."}

      PHONG CÁCH VIẾT: ${writingStyle}
      ${nsfwBlock}
      ĐỘ DÀI: ${lengthMode === 'epic' ? 'Cực Dài (Tối thiểu 1500 chữ,miêu tả chi tiết mọi thứ.Show,dont tell)' : lengthMode}.

      OUTPUT JSON STRUCTURE:⚠️ **CRITICAL NARRATIVE RULE**: The 'narrative' field is for immersive storytelling ONLY. You are STRICTLY PROHIBITED from mentioning the exact numbers from 'PRE-CALCULATED TIME' or 'CURRENT WALLET' inside the 'narrative' text. Keep all exact numbers hidden inside the 'stats' object.
      {
        "thoughtProcess": "Suy nghĩ logic về hướng đi cốt truyện, sử dụng thời gian được cung cấp...",
        "timePassed": 0, // Giá trị này chỉ để tham khảo, lấy từ input
        "stats": {
            "inventory": ["Item A", "Item B"], 
            "attributes": [{"key": "Sức khỏe", "value": "Bình thường"}],
            "status": "Trạng thái nhân vật",
            "name": "${heroName}",
            "realm": "Cảnh giới",
            "currency": "String (Updated Money)",
            "currentTime": "String (The Provided Time)"
        },
        "options": [
            {"label": "Hành động 1", "action": "..."},
            {"label": "Hành động 2", "action": "..."}
        ],
        "narrative": "Đoạn văn 1...\\n\\nĐoạn văn 2...\\n\\nĐoạn văn 3..."
      }

      ⚠️ LƯU Ý QUAN TRỌNG CUỐI CÙNG: BẠN BẮT BUỘC PHẢI TRẢ VỀ ĐỊNH DẠNG JSON HỢP LỆ. TUYỆT ĐỐI KHÔNG ĐƯỢC LIỆT KÊ TỪ VỰNG HOẶC TRẢ VỀ CHUỖI VĂN BẢN THÔNG THƯỜNG.
    `;

    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        thoughtProcess: { type: Type.STRING },
        narrative: { type: Type.STRING },
        timePassed: { type: Type.NUMBER, description: "Minutes passed in this turn" },
        stats: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            realm: { type: Type.STRING },
            status: { type: Type.STRING },
            inventory: { type: Type.ARRAY, items: { type: Type.STRING } },
            attributes: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { key: { type: Type.STRING }, value: { type: Type.STRING } } } },
            currency: { type: Type.STRING, description: "Calculated currency string" },
            currentTime: { type: Type.STRING, description: "Calculated context time string" },
            currentLocation: { type: Type.STRING, description: "Detailed location name" },
            mapData: { 
                type: Type.OBJECT,
                properties: {
                    locationName: { type: Type.STRING },
                    currentFloor: { type: Type.STRING },
                    layout: { 
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                floorName: { type: Type.STRING },
                                rooms: { type: Type.ARRAY, items: { type: Type.STRING } }
                            }
                        }
                    }
                }
            }
          },
          required: ["currency"]
        },
        options: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING },
              action: { type: Type.STRING }
            }
          }
        }
      },
      required: ["narrative", "stats", "timePassed"]
    };

    try {
      const recentHistory = history.slice(-500);

      const contents = recentHistory.map(t => ({
        role: t.role,
        parts: [{ text: t.role === 'user' ? (t.userPrompt || '[Người chơi im lặng / Tiếp tục/Chuyển cảnh/Time skip...]') : (t.narrative || '[Tiếp tục diễn biến / Diễn biến mới/Time Skip(dến thời gian hợp lý)]') }]
      }));

      contents.push({
        role: 'user',
        parts: [{ text: userPrompt }]
      });

      // Use the model selected by the user, or default to Pro
      const isFirstTurn = history.length === 0;
      const selectedModel = this.getModel('main', modelName || DEFAULT_MODEL);

      let response;
      try {
        response = await this.ai.models.generateContent({
          model: selectedModel,
          contents: contents,
          config: {
            systemInstruction: systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: schema,
            temperature: 0.85, // Giảm từ 0.85 xuống 0.7 để bớt ảo giác
            topP: 0.9, // Thêm topP
            topK: 40, // Thêm topK
            safetySettings: SAFETY_SETTINGS as any,
            maxOutputTokens: 8192, 
            stopSequences: ["(End). (End).", "(End).(End)."],
            // Tắt Thinking Mode ở lượt 1 (Flash) để tối đa tốc độ, bật lại ở lượt 2 (Pro)
            ...(isFirstTurn ? {} : { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } })
          }
        });
      } catch (apiError) {
        console.error("API Call Error:", apiError);
        throw apiError; // Re-throw if it's a network/API error
      }

      const text = response.text || "{}";
      
      const formatNarrative = (narrative: string) => {
          // If it already has line breaks, just return it
          if (!narrative || narrative.includes('\\n\\n') || narrative.includes('\n\n')) {
              return narrative;
          }
          
          // Split into sentences
          const sentences = narrative.match(/[^.!?]+[.!?]+["']?\s*/g) || [narrative];
          
          let formatted = "";
          let currentParagraph = "";
          let sentenceCount = 0;
          
          for (const sentence of sentences) {
              currentParagraph += sentence;
              sentenceCount++;
              
              // Break paragraph after 2-3 sentences
              if (sentenceCount >= 2) {
                  formatted += currentParagraph.trim() + "\n\n";
                  currentParagraph = "";
                  sentenceCount = 0;
              }
          }
          
          if (currentParagraph) {
              formatted += currentParagraph.trim();
          }
          return formatted.trim();
      };

      try {
        const parsed = JSON.parse(text);
        if (parsed.narrative) {
            parsed.narrative = formatNarrative(parsed.narrative);
        }
        return { parsed, raw: text, thoughtSignature: "Storyteller Mode" };
      } catch (parseError) {
        console.error("JSON Parse Error, attempting fallback:", parseError);
        
        let parsed: any = null;
        let isCutOff = false;

        try {
            // Fallback parser: Try to extract narrative using regex
            const narrativeMatch = text.match(/"narrative"\s*:\s*"([^]*?)(?:"\s*}|"\s*,|$)/);
            let partialNarrative = narrativeMatch ? narrativeMatch[1] : "";
            
            // Clean up escaped characters
            partialNarrative = partialNarrative.replace(/\\n/g, '\n').replace(/\\"/g, '"');

            if (partialNarrative) {
                partialNarrative = formatNarrative(partialNarrative);
                parsed = {
                    narrative: partialNarrative,
                    timePassed: 0,
                    stats: {
                        name: heroName,
                        realm: "Unknown",
                        status: "Unknown",
                        inventory: [],
                        attributes: [],
                        currency: currentCurrency || "",
                        currentTime: preCalculatedTime || ""
                    },
                    options: [
                        { label: "Tiếp tục", action: "Tiếp tục" }
                    ]
                };
                isCutOff = true;
            }
        } catch (fallbackError) {
            console.error("Fallback parser also failed", fallbackError);
        }

        if (!parsed) {
            parsed = {
              isGameOver: false,
              narrative: "Hệ thống gặp lỗi khi xử lý. Vui lòng thử lại.",
              timePassed: 0,
              stats: {
                  name: heroName,
                  realm: "Unknown",
                  status: "Error",
                  inventory: [],
                  attributes: [],
                  currency: currentCurrency || "",
                  currentTime: preCalculatedTime || ""
              },
              options: [
                  { label: "Thử lại", action: "Tiếp tục" }
              ]
            };
        }

        return { 
          parsed, 
          raw: text, 
          thoughtSignature: "Fallback Mode",
          isCutOff
        };
      }
    } catch (e) {
      console.error("Generate Turn Error:", e);
      throw e;
    }
  }

  // --- AI 2: ARCHIVIST ONLY (TẠO WIKI) ---
  // Nhiệm vụ: Đọc nội dung truyện -> Tạo Wiki.
  async runGameSystem(
    narrative: string,
    worldSettings: WorldSettings
  ): Promise<{ newRegistry: any[] }> {
    
    // STATIC SYSTEM INSTRUCTION (RULES ONLY)
    const systemPrompt = `
      ROLE: Archivist (Thủ Thư).
      CONTEXT: ${worldSettings.worldContext}

      NHIỆM VỤ CỦA BẠN:
      === MODULE 3: ARCHIVIST (TẠO WIKI - QUAN TRỌNG) ===
      - Trích xuất thông tin về NPC, Địa điểm, Vật phẩm, Kỹ năng MỚI xuất hiện hoặc được nhắc đến.
      - **RULES (BẮT BUỘC)**:
          RULES:
           1. IGNORE the main hero. Focus on NPCs, Items, Places.
           2. DETAIL LEVEL: Write full biography, visual details, minimum 250 words.
           3. NSFW ARCHIVE (Chỉ khi bật EXTREME MODE): You MUST record explicit physical details including Breasts, Pussy, Ass, Virginity, Anus. Descriptions must be detailed (>250 words,chỉ có tác dụng khi bật NSFW Cực Hạn)
           4. Wiki phải lưu mọi mục bằng Tiếng Việt.
           5. ABSENT/MENTIONED ENTITIES: You MUST create full Wiki entries for characters, places, or items that are merely MENTIONED, RUMORED, or appear in MEMORIES/BACKSTORY, even if they are not physically present in the scene. 
              - Extract every detail available (reputation, relationships, past deeds).
             - Infer/Extrapolate appearance and personality based on the context to ensure the description is DETAILED (>200 words).
             - DO NOT wait for them to appear. Archive them NOW.
           6. Lưu cả tên nhân vật chính(Player).  

      === [PROTOCOL: NAME INTEGRITY & COMPLETENESS (BẮT BUỘC LƯU TÊN ĐẦY ĐỦ)] ===
      ⚠️ **CRITICAL RULE**: NEVER TRUNCATE NAMES.
      1. **FULL NAME ENFORCEMENT**:
         - You MUST save the entity with their **FULL NAME** (First Name + Last Name).
         - **STRICTLY PROHIBITED**: Saving "Emma" when the character is "Emma Watson". Saving "Dasha" when it is "Dasha Taran".
         - **LOGIC**: If the text says "Emma" looked at him, but the context implies it is "Emma Watson", the Entry Name MUST be "Emma Watson".
      2. **CHECK BEFORE SAVE**:
         - Ask yourself: "Is 'Dasha' the full name?" -> No -> Change to "Dasha Taran".
         - Ask yourself: "Is 'Luffy' the full name?" -> No -> Change to "Monkey D. Luffy".
      
      === [ENTITY RESOLUTION & DEDUPLICATION] ===
      1. **FULL NAME PRIORITY (Ưu Tiên Tên Đầy Đủ)**: 
         - ALWAYS create/update entries using the character's LONGEST, MOST COMPLETE NAME.
         - Không lưu lặp ,ví dụ : Orihime Inoue thì không lưu thêm Inoue Orihime nữa.Không lưu chỉ nguyên Inoue hay Orihime mà phải lưu đầy đủ Orihime Inoue.
      2. **ALIAS MERGING (Gộp Biệt Danh)**: 
         - Treat surnames (Họ), first names (Tên), or nicknames as ALIASES of the main entity. 
         - Consolidate all details into the MAIN ENTRY (Full Name).

      OUTPUT JSON FORMAT:
      {
        "newRegistry": [
            {
                "name": "Tên Đầy Đủ",
                "type": "NPC/LOCATION/ITEM/FACTION/SKILL",
                "description": "Mô tả chi tiết >100 chữ...",
                "status": "Trạng thái hiện tại",
                "appearance": "Ngoại hình.(nếu là Nữ ,hãy miêu tả Vú,lồn,mông,...Chi tiết)",
                "personality": "Tính cách...",
                "secrets": "Bí mật (nếu có)..."
            }
        ]
      }
    `;

    // DATA TO PROCESS (PASS AS USER MESSAGE)
    const userMessage = `
    [INPUT STORY NARRATIVE START]
    ${narrative}
    [INPUT STORY NARRATIVE END]
    
    TASK: Based on the narrative above, extract and create detailed Wiki entries following all rules.
    `;

    const schema: Schema = {
        type: Type.OBJECT,
        properties: {
            newRegistry: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        name: { type: Type.STRING },
                        type: { type: Type.STRING, enum: ['NPC', 'LOCATION', 'FACTION', 'ITEM', 'KNOWLEDGE', 'SKILL'] },
                        description: { type: Type.STRING },
                        status: { type: Type.STRING },
                        appearance: { type: Type.STRING },
                        personality: { type: Type.STRING },
                        secrets: { type: Type.STRING },
                        powerLevel: { type: Type.STRING },
                        affiliation: { type: Type.STRING }
                    },
                    required: ["name", "type", "description"]
                }
            }
        },
        required: ["newRegistry"]
    };

    try {
        const response = await this.ai.models.generateContent({
            model: this.getModel('archivist', ARCHIVIST_MODEL),
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: 'application/json',
                responseSchema: schema,
                temperature: 0.3, // Lower temp for extraction accuracy
                safetySettings: SAFETY_SETTINGS as any
            }
        });

        const text = response.text || "{}";
        const parsed = JSON.parse(text);
        
        return {
            newRegistry: Array.isArray(parsed.newRegistry) ? parsed.newRegistry : []
        };
    } catch (e) {
        console.error("Archivist Error:", e);
        return { newRegistry: [] };
    }
  }

  async generateWorldAssist(genre: GameGenre, prompt: string, info: any): Promise<WorldSettings> {
    const schema: Schema = {
        type: Type.OBJECT,
        properties: {
            worldContext: { type: Type.STRING },
            plotDirection: { type: Type.STRING },
            majorFactions: { type: Type.STRING },
            keyNpcs: { type: Type.STRING },
            openingStory: { type: Type.STRING },
            crossoverWorlds: { type: Type.STRING }
        },
        required: ["worldContext", "plotDirection", "majorFactions", "keyNpcs"]
    };

    const response = await this.ai.models.generateContent({
        model: this.getModel('main', DEFAULT_MODEL),
        contents: `Genre: ${genre}. Prompt: ${prompt}. Generate JSON settings.`,
        config: { 
            responseMimeType: 'application/json',
            responseSchema: schema,
            temperature: 0.8,
            safetySettings: SAFETY_SETTINGS as any
        }
    });
    const cleanText = (response.text || "{}").replace(/```json\n?|```/g, '').trim();
    return JSON.parse(cleanText);
  }

  async generateSingleWorldField(genre: GameGenre, label: string, context: string, heroInfo: any): Promise<string> {
    const response = await this.ai.models.generateContent({
        model: this.getModel('main', DEFAULT_MODEL),
        contents: `Genre: ${genre}. Field: ${label}. Context: ${context}. Short generation.`,
        config: {
            safetySettings: SAFETY_SETTINGS as any
        }
    });
    return response.text || "";
  }

  async summarizeStory(currentSummary: string, recentTurns: Turn[]): Promise<string> {
      const text = recentTurns.map(t => t.narrative).join("\n");
      const prompt = currentSummary 
          ? `Tóm tắt cốt truyện cũ:\n${currentSummary}\n\nDiễn biến mới:\n${text}\n\nHãy viết một bản tóm tắt mới bao gồm cả cốt truyện cũ và diễn biến mới một cách súc tích.`
          : `Hãy tóm tắt diễn biến sau một cách súc tích:\n${text}`;
          
      const response = await this.ai.models.generateContent({
          model: this.getModel('archivist', ARCHIVIST_MODEL), // Use Lite for summary
          contents: prompt,
          config: {
              temperature: 0.4,
              safetySettings: SAFETY_SETTINGS as any
          }
      });
      return response.text || currentSummary;
  }
  
  async analyzeItem(itemName: string, context: string, genre: string): Promise<{description: string, type: string, rank: string, status?: string}> {
      const response = await this.ai.models.generateContent({
          model: this.getModel('main', DEFAULT_MODEL),
          contents: `Analyze: ${itemName}. JSON Output.`,
          config: { 
              responseMimeType: 'application/json',
              safetySettings: SAFETY_SETTINGS as any
          }
      });
      return JSON.parse(response.text || "{}");
  }

  async generateWorldFromTitle(title: string, genre: string, heroInfo: any): Promise<WorldSettings> {
      const schema: Schema = {
          type: Type.OBJECT,
          properties: {
              worldContext: { type: Type.STRING },
              plotDirection: { type: Type.STRING },
              majorFactions: { type: Type.STRING },
              keyNpcs: { type: Type.STRING },
              openingStory: { type: Type.STRING },
              crossoverWorlds: { type: Type.STRING }
          },
          required: ["worldContext", "plotDirection", "majorFactions", "keyNpcs"]
      };

      const response = await this.ai.models.generateContent({
          model: this.getModel('main', DEFAULT_MODEL),
          contents: `Generate world from title: ${title}. JSON.`,
          config: { 
              responseMimeType: 'application/json',
              responseSchema: schema,
              temperature: 0.8,
              safetySettings: SAFETY_SETTINGS as any
          }
      });
      return JSON.parse((response.text || "{}").replace(/```json\n?|```/g, '').trim());
  }
  
  // NEW: Manual Auto-Fill Wiki Entry
  async generateAbilityDescription(name: string, shortDescription: string, genre: string, worldContext: string): Promise<string> {
    const systemPrompt = `
      ROLE: Lore Master (Chuyên gia sáng tạo kỹ năng/năng lực).
      GENRE: ${genre}
      WORLD CONTEXT: ${worldContext}

      NHIỆM VỤ:
      Người chơi vừa tạo một năng lực mới cho nhân vật chính.
      Tên năng lực: "${name}"
      Mô tả ngắn: "${shortDescription}"

      Hãy viết một đoạn mô tả chi tiết (khoảng 3-5 câu) cho năng lực này.
      Mô tả cần bao gồm:
      - Cách thức hoạt động (visual effects, cảm giác khi sử dụng).
      - Điểm mạnh / Ứng dụng thực tế.
      - Điểm yếu / Giới hạn / Tiêu hao (mana, thể lực, thời gian hồi chiêu...).
      
      Văn phong phải cực kỳ ngầu, đậm chất tiểu thuyết ${genre}, và phù hợp với bối cảnh thế giới.
      CHỈ TRẢ VỀ ĐOẠN VĂN MÔ TẢ, KHÔNG THÊM BẤT KỲ LỜI BÌNH LUẬN NÀO KHÁC.
    `;

    try {
      const response = await this.ai.models.generateContent({
        model: this.getModel('chronos', CHRONOS_MODEL), // Dùng model nhanh cho việc này
        contents: { role: 'user', parts: [{ text: `Hãy viết mô tả chi tiết cho năng lực: ${name}` }] },
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
      return response.text || shortDescription;
    } catch (e) {
      console.error("Ability Gen Error:", e);
      return shortDescription;
    }
  }

  async generateWikiEntry(
      name: string, 
      type: string, 
      context: string,
      isNSFW: boolean | undefined,
      nsfwIntensity: NSFWIntensity | undefined
  ): Promise<{description: string, appearance?: string, personality?: string, secrets?: string, status?: string}> {
      
      const detailInstruction = (isNSFW && nsfwIntensity === 'extreme') 
          ? "Yêu cầu miêu tả cực kỳ chi tiết, trần trụi về cơ thể và tính dục (Body/Anatomy). Tối thiểu 500 từ."
          : "Yêu cầu miêu tả chi tiết, sinh động, chuẩn phong cách văn học. Tối thiểu 600 từ.";

      const prompt = `
          ROLE: Wiki Generator.
          TASK: Create a detailed entry for "${name}" (Type: ${type}).
          CONTEXT: ${context}
          
          RULES:
          1. ${detailInstruction}
          2. Output JSON ONLY.
      `;

      const schema: Schema = {
          type: Type.OBJECT,
          properties: {
              description: { type: Type.STRING },
              appearance: { type: Type.STRING },
              personality: { type: Type.STRING },
              secrets: { type: Type.STRING },
              status: { type: Type.STRING }
          },
          required: ["description"]
      };

      try {
          const response = await this.ai.models.generateContent({
              model: this.getModel('main', DEFAULT_MODEL),
              contents: prompt,
              config: {
                  responseMimeType: 'application/json',
                  responseSchema: schema,
                  temperature: 0.85,
                  safetySettings: SAFETY_SETTINGS as any
              }
          });
          return JSON.parse(response.text || "{}");
      } catch (e) {
          return { description: "Lỗi tạo thông tin." };
      }
  }

  async generateImage(prompt: string, nsfwIntensity?: string): Promise<string | null> {
      try {
          let finalPrompt = prompt;
          if (nsfwIntensity === 'extreme') {
              finalPrompt += " (NSFW, extremely detailed, uncensored, highly graphic)";
          } else if (nsfwIntensity === 'soft') {
              finalPrompt += " (Sensual, artistic, soft NSFW, suggestive)";
          }

          const modelToUse = this.getModel('image', 'gemini-2.5-flash-image');

          const response = await this.ai.models.generateContent({
              model: modelToUse,
              contents: {
                  parts: [
                      {
                          text: finalPrompt,
                      },
                  ],
              },
              config: {
                  // imageConfig: { aspectRatio: "1:1" } // Optional
              }
          });

          const parts = response.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
              if (part.inlineData) {
                  const base64EncodeString: string = part.inlineData.data;
                  const mimeType = part.inlineData.mimeType || 'image/png';
                  return `data:${mimeType};base64,${base64EncodeString}`;
              }
          }
          return null;
      } catch (e) {
          console.error("Image Generation Error:", e);
          return null;
      }
  }
}

export const geminiService = new GeminiService();
