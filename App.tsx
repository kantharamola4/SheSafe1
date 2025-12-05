/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import React, { useState, useRef, useEffect } from 'react';
import { SafetySentinel } from './services/geminiService';
import { motion, AnimatePresence } from 'framer-motion';

// --- Types ---
interface EmergencyContact {
    name: string;
    phone: string;
}

interface AlertLog {
    timestamp: Date;
    type: string;
    emotion: string;
    location?: string;
    imageUrl?: string;
    isSilent: boolean;
}

interface ErrorState {
    show: boolean;
    title: string;
    message: string;
    action?: string;
}

function App() {
    // --- State ---
    const [isArmed, setIsArmed] = useState(false);
    const [status, setStatus] = useState<'IDLE' | 'CONNECTING' | 'ARMED' | 'DANGER'>('IDLE');
    const [contact, setContact] = useState<EmergencyContact>({ name: '', phone: '' });
    const [logs, setLogs] = useState<AlertLog[]>([]);
    const [volume, setVolume] = useState(0); // 0-255
    const [silentMode, setSilentMode] = useState(false);
    const [blackoutMode, setBlackoutMode] = useState(false);
    
    // Permission Error State
    const [errorState, setErrorState] = useState<ErrorState>({ show: false, title: '', message: '' });
    
    const sentinelRef = useRef<SafetySentinel | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wakeLockRef = useRef<any>(null);

    // --- Android Wake Lock ---
    const requestWakeLock = async () => {
        try {
            if ('wakeLock' in navigator) {
                // @ts-ignore
                wakeLockRef.current = await navigator.wakeLock.request('screen');
            }
        } catch (err) {
            console.log('Wake Lock Error:', err);
        }
    };

    const releaseWakeLock = async () => {
        if (wakeLockRef.current) {
            await wakeLockRef.current.release();
            wakeLockRef.current = null;
        }
    };

    // --- Actions ---

    const handleError = (title: string, message: string, action?: string) => {
        setErrorState({ show: true, title, message, action });
        setStatus('IDLE');
        setIsArmed(false);
        releaseWakeLock();
    };

    // 1. Capture Evidence (Silent background task)
    const captureEvidence = async (): Promise<{ location: string, imageUrl: string }> => {
        // Location
        let locationStr = "Unknown Location";
        try {
            const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, { 
                    enableHighAccuracy: true, 
                    timeout: 5000 
                });
            });
            locationStr = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
        } catch (e) {
            console.error("Location failed", e);
            // Don't stop the alert even if location fails
        }

        // Photo
        let imageUrl = "";
        if (videoRef.current && canvasRef.current) {
            try {
                const context = canvasRef.current.getContext('2d');
                if (context) {
                    canvasRef.current.width = videoRef.current.videoWidth;
                    canvasRef.current.height = videoRef.current.videoHeight;
                    context.drawImage(videoRef.current, 0, 0);
                    imageUrl = canvasRef.current.toDataURL('image/jpeg', 0.5);
                }
            } catch(e) {
                console.error("Image capture failed", e);
            }
        }

        return { location: locationStr, imageUrl };
    };

    // 2. Trigger Alert Logic
    const triggerAlert = async (reason: string, emotion: string) => {
        // Visual Feedback Decision
        if (!silentMode) {
            setStatus('DANGER');
            setBlackoutMode(false); // Wake screen if loud mode
        }
        
        // Capture Evidence
        const evidence = await captureEvidence();

        // Log locally
        const newLog: AlertLog = {
            timestamp: new Date(),
            type: reason,
            emotion: emotion,
            location: evidence.location,
            imageUrl: evidence.imageUrl,
            isSilent: silentMode
        };
        setLogs(prev => [newLog, ...prev]);

        // Simulate SMS/API Call
        console.log(`[${silentMode ? 'SILENT' : 'LOUD'} ALERT SENT] To: ${contact.name} (${contact.phone}) | Reason: ${reason}`);
    };

    // 3. Toggle System Arm/Disarm
    const toggleArm = async () => {
        if (isArmed) {
            // Disarm
            sentinelRef.current?.stop();
            await releaseWakeLock();
            setIsArmed(false);
            setStatus('IDLE');
            setVolume(0);
            setBlackoutMode(false);
        } else {
            // Arm
            if (!contact.name || !contact.phone) {
                handleError("Setup Required", "Please enter an emergency contact name and phone number.");
                return;
            }

            setStatus('CONNECTING');

            // Initialize Hidden Camera (Background Stream)
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ 
                    video: { facingMode: 'user' },
                    audio: false // Sentinel handles audio separately
                });
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                }
            } catch (e: any) {
                let msg = "We need camera access to capture evidence during an emergency.";
                let title = "Camera Permission Failed";
                
                if (e.name === 'NotAllowedError') {
                    msg = "You have blocked camera access. Please go to your browser settings and allow camera access for this site to use the safety features.";
                } else if (e.name === 'NotFoundError') {
                    msg = "No camera found on this device.";
                } else if (e.name === 'NotReadableError') {
                    msg = "Your camera is currently in use by another application.";
                }
                
                handleError(title, msg);
                return;
            }

            // Start AI Sentinel
            sentinelRef.current = new SafetySentinel({
                onConnect: () => {
                    setStatus('ARMED');
                    requestWakeLock();
                },
                onDisconnect: () => {
                    if (status !== 'IDLE') {
                         // Only set idle if we weren't intentionally stopped
                         // But we generally leave it to the user to reset via UI if network drops
                    }
                },
                onError: (err) => {
                    handleError("Sentinel System Error", err);
                },
                onEmergencyTriggered: (reason, emotion) => triggerAlert(reason, emotion),
                onVolumeChange: (vol) => setVolume(vol)
            });

            await sentinelRef.current.start();
            setIsArmed(true);
        }
    };

    return (
        <main className="fixed inset-0 bg-black text-white font-sans flex flex-col overflow-hidden">
            {/* Hidden Evidence Capture Elements */}
            <video ref={videoRef} autoPlay playsInline muted className="hidden" />
            <canvas ref={canvasRef} className="hidden" />

            {/* Permission / Error Modal */}
            <AnimatePresence>
                {errorState.show && (
                    <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-6"
                    >
                        <motion.div 
                            initial={{ scale: 0.9 }}
                            animate={{ scale: 1 }}
                            className="bg-neutral-900 border border-red-900/50 p-6 rounded-2xl w-full max-w-sm text-center shadow-[0_0_50px_rgba(255,0,0,0.1)]"
                        >
                            <div className="w-12 h-12 bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-4">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-bold text-white mb-2">{errorState.title}</h3>
                            <p className="text-sm text-neutral-400 mb-6 leading-relaxed">{errorState.message}</p>
                            <button 
                                onClick={() => setErrorState({ show: false, title: '', message: '' })}
                                className="w-full bg-neutral-800 hover:bg-neutral-700 text-white font-bold py-3 rounded-xl transition-colors text-sm"
                            >
                                {errorState.action || 'Understood'}
                            </button>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Blackout Mode Overlay (Discreet) */}
            <AnimatePresence>
                {blackoutMode && (
                    <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={() => setBlackoutMode(false)}
                        className="absolute inset-0 z-50 bg-black flex items-center justify-center cursor-pointer"
                    >
                        {/* Only show a tiny pixel indicator if not purely silent, or nothing */}
                        {!silentMode && <div className="w-1 h-1 bg-neutral-900 rounded-full animate-pulse opacity-50"></div>}
                        <div className="absolute bottom-10 opacity-10 text-[10px]">TAP TO WAKE</div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* --- App Header --- */}
            <header className="px-5 py-4 flex justify-between items-center z-10 bg-black border-b border-neutral-900">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded border border-neutral-700 flex items-center justify-center bg-neutral-900">
                        <div className={`w-3 h-3 rounded-full ${status === 'ARMED' ? 'bg-green-500 animate-pulse' : status === 'DANGER' ? 'bg-red-500 animate-ping' : 'bg-neutral-600'}`}></div>
                    </div>
                    <div>
                        <h1 className="text-lg font-bold tracking-widest font-tech text-neutral-200">SENTINEL</h1>
                        <p className="text-[10px] text-neutral-500 uppercase tracking-wider">AI Safety System</p>
                    </div>
                </div>
                {isArmed && (
                     <button 
                        onClick={() => setBlackoutMode(true)}
                        className="text-xs text-neutral-500 border border-neutral-800 px-3 py-1 rounded hover:bg-neutral-900"
                    >
                        SCREEN OFF
                    </button>
                )}
            </header>

            {/* --- Main Content --- */}
            <div className="flex-1 relative flex flex-col items-center justify-center p-6">
                
                {/* Visualizer (Siri-like) - Only Visible when ARMED */}
                <AnimatePresence>
                    {isArmed && (
                        <motion.div 
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.8, opacity: 0 }}
                            className="absolute inset-0 flex items-center justify-center z-0"
                        >
                            <div className="relative">
                                {/* Core */}
                                <div 
                                    className={`w-32 h-32 rounded-full blur-xl transition-all duration-75 ease-out ${status === 'DANGER' ? 'bg-red-600 opacity-80' : 'bg-green-500 opacity-40'}`}
                                    style={{ transform: `scale(${1 + (volume / 255) * 1.5})` }} 
                                />
                                <div 
                                    className={`absolute inset-0 rounded-full border-2 transition-colors duration-300 ${status === 'DANGER' ? 'border-red-500' : 'border-green-500'}`} 
                                    style={{ transform: `scale(${1 + (volume / 255) * 0.5})` }}
                                />
                                {/* Rings */}
                                <div className="absolute inset-0 rounded-full border border-white/10 animate-[ping_3s_linear_infinite]"></div>
                                <div className="absolute inset-0 rounded-full border border-white/5 animate-[ping_4s_linear_infinite_1s]"></div>
                            </div>
                            
                            <div className="absolute bottom-20 text-center">
                                <p className={`text-xl font-tech tracking-widest ${status === 'DANGER' ? 'text-red-500' : 'text-green-500'}`}>
                                    {status === 'DANGER' ? 'THREAT DETECTED' : 'SENTINEL ACTIVE'}
                                </p>
                                <p className="text-xs text-neutral-600 mt-2 font-mono uppercase">
                                    Acoustic Forensics Online
                                </p>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Setup Form (Only when IDLE) */}
                <AnimatePresence>
                    {!isArmed && (
                        <motion.div 
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -20 }}
                            className="w-full max-w-sm z-10"
                        >
                            <div className="bg-neutral-900/50 backdrop-blur border border-neutral-800 p-6 rounded-2xl mb-6">
                                <h2 className="text-xs font-bold text-neutral-400 uppercase tracking-widest mb-6 border-b border-neutral-800 pb-2">Configuration</h2>
                                
                                <div className="space-y-5">
                                    <div>
                                        <label className="text-[10px] text-neutral-500 uppercase font-bold ml-1">Contact Name</label>
                                        <input 
                                            type="text" 
                                            value={contact.name}
                                            onChange={e => setContact({...contact, name: e.target.value})}
                                            className="w-full bg-black border border-neutral-800 p-3 rounded text-sm focus:border-green-500 outline-none transition-colors text-white mt-1"
                                            placeholder="e.g. Mom"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-neutral-500 uppercase font-bold ml-1">Phone Number</label>
                                        <input 
                                            type="tel" 
                                            value={contact.phone}
                                            onChange={e => setContact({...contact, phone: e.target.value})}
                                            className="w-full bg-black border border-neutral-800 p-3 rounded text-sm focus:border-green-500 outline-none transition-colors text-white mt-1"
                                            placeholder="e.g. +1 555 0123"
                                        />
                                    </div>

                                    <div className="flex items-center justify-between bg-neutral-950 p-3 rounded border border-neutral-800">
                                        <div>
                                            <p className="text-sm font-bold text-neutral-300">Silent Mode</p>
                                            <p className="text-[10px] text-neutral-500">No screen flash or sound on trigger</p>
                                        </div>
                                        <button 
                                            onClick={() => setSilentMode(!silentMode)}
                                            className={`w-10 h-5 rounded-full relative transition-colors ${silentMode ? 'bg-green-500' : 'bg-neutral-700'}`}
                                        >
                                            <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${silentMode ? 'left-6' : 'left-1'}`} />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <button 
                                onClick={toggleArm}
                                className="w-full bg-white text-black font-bold py-4 rounded-xl shadow-[0_0_20px_rgba(255,255,255,0.2)] hover:bg-neutral-200 active:scale-95 transition-all flex items-center justify-center gap-2"
                            >
                                {status === 'CONNECTING' ? (
                                    <svg className="animate-spin h-5 w-5 text-black" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                ) : (
                                    <>
                                        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                                        ACTIVATE SENTINEL
                                    </>
                                )}
                            </button>

                            <p className="text-center text-[10px] text-neutral-600 mt-4 max-w-[250px] mx-auto leading-tight">
                                By activating, you grant permission to monitor audio and capture photos during emergencies.
                            </p>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Log List (Only visible if logs exist and not completely obscured) */}
                {logs.length > 0 && !blackoutMode && !isArmed && (
                    <div className="w-full max-w-sm mt-8 z-10">
                        <h3 className="text-[10px] uppercase font-bold text-neutral-500 mb-2 ml-1">Recent Alerts</h3>
                        <div className="space-y-2 max-h-40 overflow-y-auto no-scrollbar">
                            {logs.map((log, i) => (
                                <div key={i} className="bg-neutral-900 border border-neutral-800 p-3 rounded flex items-start gap-3">
                                    {log.imageUrl && <img src={log.imageUrl} className="w-10 h-10 object-cover rounded bg-neutral-800" alt="Evidence" />}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex justify-between">
                                            <span className="text-red-400 font-bold text-xs">{log.type}</span>
                                            <span className="text-neutral-600 text-[10px]">{log.timestamp.toLocaleTimeString()}</span>
                                        </div>
                                        <p className="text-neutral-500 text-[10px] truncate">{log.location}</p>
                                        <div className="flex gap-1 mt-1">
                                            {log.isSilent && <span className="text-[8px] bg-neutral-800 text-neutral-400 px-1 rounded">SILENT</span>}
                                            <span className="text-[8px] bg-red-900/30 text-red-500 px-1 rounded">{log.emotion}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom Controls (Armed State) */}
            {isArmed && (
                <div className="p-6 pb-10 z-10 flex justify-center">
                    <button 
                        onClick={toggleArm}
                        className="bg-neutral-900 border border-neutral-700 text-neutral-400 px-8 py-3 rounded-full text-xs font-bold tracking-widest hover:bg-neutral-800 active:bg-neutral-700 transition-colors"
                    >
                        DISARM SYSTEM
                    </button>
                </div>
            )}

            {/* Background Grid */}
            <div className="absolute inset-0 bg-[linear-gradient(to_right,#111_1px,transparent_1px),linear-gradient(to_bottom,#111_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none z-0 opacity-20"></div>
        </main>
    );
}

export default App;