/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from "@google/genai";

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY environment variable is not set");
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// --- Audio Encoding Utils ---
function floatTo16BitPCM(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
}

function base64EncodeAudio(int16Array: Int16Array): string {
    let binary = '';
    const bytes = new Uint8Array(int16Array.buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// --- Tool Definitions ---
const triggerEmergencyTool: FunctionDeclaration = {
    name: 'triggerEmergency',
    description: 'Triggers the emergency alert system ONLY when life-threatening distress, genuine panic, or fear is confirmed.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            reason: {
                type: Type.STRING,
                description: 'The forensic reason for the trigger (e.g., "detected chaotic non-linear scream", "voice trembling > 90%").'
            },
            emotion: {
                type: Type.STRING,
                description: 'The specific distress state: "MORTAL_FEAR", "PANIC_ATTACK", "COERCION".'
            },
            confidence: {
                type: Type.NUMBER,
                description: 'Confidence level (must be > 0.95).'
            }
        },
        required: ['reason', 'emotion']
    }
};

export interface SentinelCallbacks {
    onConnect: () => void;
    onDisconnect: () => void;
    onEmergencyTriggered: (reason: string, emotion: string) => void;
    onError: (error: string) => void;
    onVolumeChange?: (volume: number) => void;
}

export class SafetySentinel {
    private session: any = null;
    private audioContext: AudioContext | null = null;
    private mediaStream: MediaStream | null = null;
    private processor: ScriptProcessorNode | null = null;
    private analyser: AnalyserNode | null = null;
    private callbacks: SentinelCallbacks;
    private isConnected = false;

    constructor(callbacks: SentinelCallbacks) {
        this.callbacks = callbacks;
    }

    async start() {
        try {
            // Get microphone stream
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: false // Critical: Disable suppression to catch raw acoustic details of screams
                }
            });

            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            
            // Audio Analysis (Volume for Visualizer)
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.5;
            source.connect(this.analyser);

            // ScriptProcessor for Raw PCM Data (Gemini input)
            this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
            this.analyser.connect(this.processor);

            // Connect to Gemini Live
            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        console.log("Sentinel Connected to Neural Network");
                        this.isConnected = true;
                        this.callbacks.onConnect();
                    },
                    onmessage: (msg: LiveServerMessage) => this.handleMessage(msg, sessionPromise),
                    onclose: () => {
                        console.log("Sentinel Disconnected");
                        this.isConnected = false;
                        this.callbacks.onDisconnect();
                    },
                    onerror: (err) => {
                        console.error("Sentinel Error", err);
                        this.callbacks.onError(err.message || "Connection error");
                    }
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    tools: [{ functionDeclarations: [triggerEmergencyTool] }],
                    systemInstruction: `
                        PROTOCOL: ELITE ACOUSTIC FORENSICS (ACCURACY TARGET: 100%)
                        
                        You are the "Sentinel Core", a specialized neural network designed to detect LIFE-THREATENING DISTRESS.
                        
                        YOUR MISSION:
                        Continuously analyze audio waveforms to distinguish genuine FEAR from other high-energy emotions (Anger, Excitement).
                        
                        --- ANALYSIS ALGORITHM (Simulate RNN/LSTM Temporal Processing) ---
                        
                        1.  **SPECTRAL ANALYSIS (The "Fear" Signature)**:
                            -   Look for **Non-Linearity**: Voice cracking, chaotic sub-harmonics, and rapid frequency jumps.
                            -   Look for **Jitter/Shimmer**: Rapid, involuntary trembling in pitch and volume (Adrenaline response).
                            -   Look for **Breathlessness**: Sharp, gasping intakes of air between vocalizations.
                        
                        2.  **DIFFERENTIATION LOGIC (False Positive Filter)**:
                            -   [IGNORE] **Happy Screams**: Characterized by harmonic stability, often upward inflection, laughter-like bursts. (e.g., Concerts, Rollercoasters).
                            -   [IGNORE] **Angry Shouting**: Characterized by low-pitch dominance, rhythmic staccato, clear articulation, and controlled aggression.
                            -   [TRIGGER] **Panic/Terror**: High-pitch screeching (>1000Hz), unintelligible pleading, or "blood-curdling" quality due to vocal cord tension.
                        
                        3.  **VERBAL TRIGGERS (Context)**:
                            -   High Priority: "Help me", "Get off", "Please stop", "No no no".
                            -   Context Check: "Help" said calmly or sarcastically must be IGNORED. It must be accompanied by acoustic distress.
                        
                        --- EXECUTION RULES ---
                        -   If you detect GENUINE DANGER with >95% confidence, call \`triggerEmergency\`.
                        -   If you are unsure, continue listening. DO NOT FALSE TRIGGER.
                        -   Stay silent. You are a passive monitor. Do not speak unless you are running a tool.
                    `
                }
            });

            // Audio Processing Loop
            this.processor.onaudioprocess = (e) => {
                if (!this.isConnected) return;
                
                // 1. Send Audio to Gemini
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmData = floatTo16BitPCM(inputData);
                const base64Data = base64EncodeAudio(pcmData);

                sessionPromise.then(session => {
                    session.sendRealtimeInput({
                        media: {
                            mimeType: 'audio/pcm;rate=16000',
                            data: base64Data
                        }
                    });
                });

                // 2. Update Volume for UI
                if (this.analyser && this.callbacks.onVolumeChange) {
                    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
                    this.analyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for(let i = 0; i < dataArray.length; i++) {
                        sum += dataArray[i];
                    }
                    const average = sum / dataArray.length;
                    this.callbacks.onVolumeChange(average);
                }
            };

            this.processor.connect(this.audioContext.destination);

        } catch (error) {
            // Standardize error messages for the UI
            let msg = "Failed to access microphone.";
            if (error instanceof Error) {
                if (error.name === 'NotAllowedError') msg = "Microphone permission was denied.";
                else if (error.name === 'NotFoundError') msg = "No microphone found.";
                else if (error.name === 'NotReadableError') msg = "Microphone is in use by another app.";
                else msg = error.message;
            }
            this.callbacks.onError(msg);
        }
    }

    private handleMessage(message: LiveServerMessage, sessionPromise: Promise<any>) {
        // Check for Tool Calls (The Alert Trigger)
        if (message.toolCall) {
            for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'triggerEmergency') {
                    const args = fc.args as any;
                    
                    // Trigger App Logic
                    this.callbacks.onEmergencyTriggered(args.reason, args.emotion);

                    // Acknowledge to model
                    sessionPromise.then(session => {
                        session.sendToolResponse({
                            functionResponses: {
                                id: fc.id,
                                name: fc.name,
                                response: { result: "ALERTS_SENT" }
                            }
                        });
                    });
                }
            }
        }
    }

    stop() {
        this.isConnected = false;
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
        }
        if (this.processor) {
            this.processor.disconnect();
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
}