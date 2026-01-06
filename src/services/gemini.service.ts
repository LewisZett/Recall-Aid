import { Injectable } from '@angular/core';
import { GoogleGenAI, Type, SchemaType } from '@google/genai';
import { LIFE_LOG } from './lifelog.data';

export interface ObservationResult {
  needsAssistance: boolean;
  confidence: number;
  observation: string;
  contextTrigger?: string;
}

@Injectable({
  providedIn: 'root'
})
export class GeminiService {
  private ai: GoogleGenAI;
  private modelId = 'gemini-2.5-flash';

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env['API_KEY'] });
  }

  // The "Observer": Fast, low latency check
  async observeEnvironment(base64Image: string, base64Audio: string | null = null): Promise<ObservationResult> {
    const prompt = `
      You are the 'Observer' for Recall Aid. 
      Analyze the video frame ${base64Audio ? 'AND the ambient audio snippet' : ''}.
      
      Look/Listen for:
      1. Specific signs of hesitation or confusion.
      2. Searching behaviors.
      3. Safety hazards (e.g. "Ouch", crashing sounds, spilled water).
      4. Interaction with critical items.
      5. Verbal requests for help or expressions of distress in the audio.
      
      Constraint: Be conservative. Only flag 'needsAssistance' if you are > 60% confident.
      Return JSON.
    `;

    const parts: any[] = [
      { text: prompt },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Image
        }
      }
    ];

    // Add audio part if valid and has meaningful length
    if (base64Audio && base64Audio.length > 100) {
      parts.push({
        inlineData: {
          mimeType: 'audio/wav',
          data: base64Audio
        }
      });
    }

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelId,
        contents: {
          role: 'user',
          parts: parts
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              needsAssistance: { type: Type.BOOLEAN },
              confidence: { type: Type.NUMBER, description: "0.0 to 1.0" },
              observation: { type: Type.STRING },
              contextTrigger: { type: Type.STRING, description: "What triggered this? e.g., 'Looking at pill bottle' or 'Heard loud crash'" }
            },
            required: ["needsAssistance", "confidence", "observation"]
          }
        }
      });

      const text = response.text;
      if (!text) throw new Error("No response from Observer");
      return JSON.parse(text) as ObservationResult;
    } catch (e: any) {
      console.error("Observer Error Details:", e);
      // Fallback: If audio caused 400 error, try again without audio
      if (base64Audio && e.message && (e.message.includes('400') || e.message.includes('INVALID_ARGUMENT'))) {
         console.log("Retrying observation without audio...");
         return this.observeEnvironment(base64Image, null);
      }
      return { needsAssistance: false, confidence: 0, observation: "Error observing environment." };
    }
  }

  // The "Reasoner": Deep thinking with context
  async reasonAndAssist(base64Image: string, input: string, mode: 'observation' | 'question' = 'observation'): Promise<string> {
    const lifeLogStr = JSON.stringify(LIFE_LOG, null, 2);
    
    // Extract critical items for the prompt context to guide detection
    const criticalItems = Object.values(LIFE_LOG.home_map)
      .flatMap((room: any) => room.critical_items || [])
      .join(', ');
    
    let specificTask = '';
    
    if (mode === 'question') {
      specificTask = `
        USER QUESTION: "${input}"
        TASK: Answer the user's question directly using visual evidence and the Life Log.
        If they ask "Where is X", look for X in the image or use the Home Map in the Life Log.
      `;
    } else {
      specificTask = `
        CURRENT OBSERVATION: "${input}"
        KNOWN CRITICAL ITEMS TO LOOK FOR: [${criticalItems}]

        TASK: Determine what 'Alice' is trying to do. Identify confusion. Formulate a proactive, supportive nudge.

        STRATEGY:
        1. Analyze the observation for 'searching' or 'missing object' intent.
        2. CROSS-REFERENCE the visual input against the 'KNOWN CRITICAL ITEMS' list to see if any are present.
        3. CONSULT the 'home_map' in the Life Log for the object's usual location.
        4. CHECK if the object is actually visible in the current frame.
        5. Formulate the nudge:
           - If object is visible: "Alice, your [object] is right there on the [location in image]."
           - If not visible: "Alice, check the [location from Life Log], that's where you usually keep your [object]."
      `;
    }

    const prompt = `
      You are the 'Reasoner' for Recall Aid.
      
      CONTEXT (Life Log):
      ${lifeLogStr}

      ${specificTask}

      GENERAL INSTRUCTIONS:
      1. Analyze the image deeply.
      2. Identify people using the Social Circle data if present.
      3. Keep the response short (max 2 sentences), spoken, and supportive.
      
      OUTPUT:
      Just the plain text to be spoken.
    `;

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelId,
        contents: {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Image
              }
            }
          ]
        },
        config: {
          thinkingConfig: {
            thinkingBudget: 1024, 
          },
        }
      });

      return response.text || "I'm here if you need help.";
    } catch (e) {
      console.error("Reasoner Error:", e);
      return "I am having trouble connecting. Please be careful.";
    }
  }
}