// ─── AEGIS GLOBAL — AI Intelligence Panel ────────────────────────────────────
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAIAnalysis, useDisasters } from '../../hooks';
import { useDisasterStore } from '../../store';
import { aiApi } from '../../utils/api';
import { formatDistanceToNow } from 'date-fns';

interface Message {
  id:        string;
  role:      'user' | 'assistant';
  content:   string;
  timestamp: Date;
  isLoading?:boolean;
}

const QUICK_PROMPTS = [
  { label: '72h global risk brief',         prompt: 'Generate a 72-hour global disaster risk brief. Which events are most likely to escalate, what total population is at risk, and what are the top 3 pre-emptive government actions needed right now?' },
  { label: 'Compare 2004 vs 2011 Tsunami',  prompt: 'Compare the 2004 Indian Ocean Tsunami and the 2011 Japan Tsunami. Key similarities, differences in response effectiveness, and what lessons from both should guide response to any current tsunami threats.' },
  { label: 'Resource allocation strategy',  prompt: 'Analyze current resource allocation across all active disasters. Which events are underserved? Give a specific reallocation plan prioritising lives saved per resource deployed.' },
  { label: 'Climate vulnerability ranking', prompt: 'Rank the top 10 most climate-vulnerable countries for 2025–2030. Use composite factors: disaster frequency trend, GDP exposure, infrastructure resilience, early warning coverage, and historical fatality rates.' },
  { label: 'Disease outbreak risk',         prompt: 'Assess disease outbreak risk following current flood events in Bangladesh and Mozambique. Which pathogens are most likely, what are the incubation timelines, and what public health interventions are most urgent?' },
  { label: 'Earthquake aftershock model',   prompt: 'Using Omori-Utsu law, model expected aftershock sequence for a M7.2 earthquake in Turkey. What magnitude range should rescue teams prepare for in the next 72 hours, and how should operations be adjusted?' },
];

const SYSTEM_CONTEXT = `You are AEGIS AI — embedded in the AEGIS GLOBAL disaster intelligence platform. Current active events: Turkey M7.2 earthquake (847 dead, 1,180 missing), Bangladesh mega-floods (2.1M affected), Philippines Typhoon Mawar Cat 4 (landfall imminent), California wildfire (55K acres, 30% contained), Mt. Merapi eruption Alert IV (82K displaced). You have access to 22,847 historical disaster records and all AEGIS platform modules. Be specific, data-driven, and actionable. Speak as a senior expert to field commanders and government officials.`;

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user';

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-sm
        ${isUser ? 'bg-blue-600' : 'bg-purple-700'}`}>
        {isUser ? '👤' : '🤖'}
      </div>
      <div className={`flex-1 max-w-[85%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`text-xs mb-1 px-1 ${isUser ? 'text-right text-slate-500' : 'text-slate-500'}`}>
          {isUser ? 'You' : 'AEGIS AI'} · {formatDistanceToNow(msg.timestamp, { addSuffix: true })}
        </div>
        {msg.isLoading ? (
          <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl rounded-tl-sm px-4 py-3">
            <div className="flex gap-1.5 items-center">
              <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        ) : (
          <div className={`px-4 py-3 rounded-xl text-sm leading-relaxed whitespace-pre-wrap
            ${isUser
              ? 'bg-blue-600 text-white rounded-tr-sm'
              : 'bg-[#141b2d] border border-[#1e2d4a] text-slate-200 rounded-tl-sm'
            }`}>
            {msg.content}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AIIntelligence() {
  const [messages,    setMessages]    = useState<Message[]>([{
    id:        'welcome',
    role:      'assistant',
    content:   `Welcome to AEGIS AI Intelligence Engine.\n\nI have real-time awareness of all active disaster events, historical records from 1900 to present, satellite data, and predictive model outputs across all 23 disaster categories.\n\nI can help you with:\n• Real-time situation reports and analysis\n• Historical disaster comparisons and lessons\n• Resource allocation and response optimisation\n• Risk predictions and early warning analysis\n• Country vulnerability assessments\n• Recovery planning and cost projections\n\nClick a quick prompt below or ask me anything about current or historical disasters.`,
    timestamp: new Date(),
  }]);
  const [input,       setInput]       = useState('');
  const [sessionId,   setSessionId]   = useState<string | undefined>();
  const [outputFormat,setOutputFormat]= useState<'narrative' | 'structured' | 'brief'>('narrative');
  const [isLoading,   setIsLoading]   = useState(false);
  const [sitrep,      setSitrep]      = useState<string | null>(null);
  const [sitrepLoading, setSitrepLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const { getSelected } = useDisasterStore();
  const selectedDisaster = getSelected();

  useDisasters();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async (text?: string) => {
    const content = text || input.trim();
    if (!content || isLoading) return;
    setInput('');

    const userMsg: Message = {
      id:        crypto.randomUUID(),
      role:      'user',
      content,
      timestamp: new Date()
    };
    const loadingMsg: Message = {
      id:        crypto.randomUUID(),
      role:      'assistant',
      content:   '',
      timestamp: new Date(),
      isLoading: true
    };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setIsLoading(true);

    try {
      const result = await aiApi.analyse({
        query:            content,
        context:          SYSTEM_CONTEXT,
        includeHistorical:content.toLowerCase().includes('histor') || content.toLowerCase().includes('compare'),
        outputFormat,
        sessionId,
        disasterId:       selectedDisaster?.id
      });

      setSessionId(result.sessionId);

      setMessages(prev => [
        ...prev.filter(m => m.id !== loadingMsg.id),
        {
          id:        crypto.randomUUID(),
          role:      'assistant',
          content:   result.analysis,
          timestamp: new Date()
        }
      ]);
    } catch {
      setMessages(prev => [
        ...prev.filter(m => m.id !== loadingMsg.id),
        {
          id:        crypto.randomUUID(),
          role:      'assistant',
          content:   'Connection error — please check your network and try again.',
          timestamp: new Date()
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, outputFormat, sessionId, selectedDisaster]);

  const generateSitrep = useCallback(async () => {
    if (!selectedDisaster) return;
    setSitrepLoading(true);
    try {
      const result = await aiApi.situationReport(selectedDisaster, 'government');
      setSitrep(result.sitrep);
    } catch {
      setSitrep('Failed to generate situation report. Please try again.');
    } finally {
      setSitrepLoading(false);
    }
  }, [selectedDisaster]);

  const clearSession = () => {
    setMessages([{
      id:        'welcome-new',
      role:      'assistant',
      content:   'Session cleared. Start a new conversation.',
      timestamp: new Date()
    }]);
    setSessionId(undefined);
    setSitrep(null);
  };

  return (
    <div className="flex h-full overflow-hidden">

      {/* Main chat area */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Chat header */}
        <div className="px-4 py-3 border-b border-[#1e2d4a] flex items-center justify-between flex-shrink-0">
          <div>
            <div className="text-sm font-semibold">🤖 AEGIS AI Intelligence Engine</div>
            <div className="text-xs text-slate-500">Powered by Claude · Disaster analysis & decision support</div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={outputFormat}
              onChange={e => setOutputFormat(e.target.value as any)}
              className="bg-[#141b2d] border border-[#1e2d4a] text-slate-300 text-xs rounded-md px-2 py-1"
            >
              <option value="narrative">Narrative</option>
              <option value="structured">Structured</option>
              <option value="brief">Brief (150w)</option>
            </select>
            <button
              onClick={clearSession}
              className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1 border border-[#1e2d4a] rounded-md"
            >Clear</button>
          </div>
        </div>

        {/* Quick prompts */}
        <div className="px-4 py-2 border-b border-[#1e2d4a] flex gap-2 overflow-x-auto flex-shrink-0">
          {QUICK_PROMPTS.map((qp) => (
            <button
              key={qp.label}
              onClick={() => sendMessage(qp.prompt)}
              disabled={isLoading}
              className="text-xs bg-[#1a2238] hover:bg-[#1e2d4a] border border-[#243350] text-blue-300 px-3 py-1.5 rounded-full whitespace-nowrap transition-all disabled:opacity-50"
            >
              {qp.label}
            </button>
          ))}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
          {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="px-4 py-3 border-t border-[#1e2d4a] flex-shrink-0">
          {selectedDisaster && (
            <div className="mb-2 flex items-center gap-2 text-xs text-blue-400/80">
              <span>📌 Context: {selectedDisaster.name}</span>
              <button onClick={generateSitrep} disabled={sitrepLoading} className="text-purple-400 hover:text-purple-300 underline disabled:opacity-50">
                {sitrepLoading ? 'Generating…' : 'Generate SITREP'}
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Ask about any disaster, request analysis, compare events, or get recommendations… (Enter to send, Shift+Enter for newline)"
              className="flex-1 bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-blue-500/50 h-16"
              disabled={isLoading}
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || isLoading}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-4 rounded-lg font-medium text-sm flex-shrink-0 transition-colors"
            >
              {isLoading ? '…' : '→'}
            </button>
          </div>
        </div>
      </div>

      {/* Right panel — SITREP + context */}
      <div className="w-72 flex-shrink-0 border-l border-[#1e2d4a] flex flex-col overflow-hidden">

        {/* Sitrep display */}
        {sitrep && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-purple-400 uppercase tracking-wider">SITREP</div>
              <button onClick={() => setSitrep(null)} className="text-slate-500 hover:text-slate-300 text-sm">✕</button>
            </div>
            <div className="bg-[#141b2d] border border-purple-900/40 rounded-lg p-3">
              <pre className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed font-sans">{sitrep}</pre>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(sitrep)}
              className="mt-2 w-full text-xs text-slate-500 hover:text-slate-300 border border-[#1e2d4a] rounded-md py-1.5"
            >Copy to clipboard</button>
          </div>
        )}

        {/* Context panel when no sitrep */}
        {!sitrep && (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Active context</div>
              {selectedDisaster ? (
                <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-lg p-3 text-xs">
                  <div className="font-medium text-blue-400 mb-1">{selectedDisaster.name}</div>
                  <div className="text-slate-400 space-y-1">
                    <div>Severity: <span className="text-red-400 font-medium">{selectedDisaster.severity}</span></div>
                    <div>Deaths: {selectedDisaster.deaths.toLocaleString()}</div>
                    <div>Affected: {selectedDisaster.affected.toLocaleString()}</div>
                    <div>Status: {selectedDisaster.status}</div>
                  </div>
                  <button
                    onClick={() => sendMessage(`Give me a comprehensive situation report and response recommendations for: ${selectedDisaster.name}. Include current status, critical gaps, and priority actions for the next 6 hours.`)}
                    className="mt-2 w-full text-xs bg-blue-600/20 hover:bg-blue-600/30 border border-blue-800 text-blue-400 rounded-md py-1.5"
                  >Analyse this disaster</button>
                </div>
              ) : (
                <div className="text-xs text-slate-600 italic">Select a disaster from the dashboard to add context</div>
              )}
            </div>

            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Session info</div>
              <div className="text-xs text-slate-600 space-y-1">
                <div>Messages: {messages.length}</div>
                <div>Session: {sessionId ? sessionId.slice(0, 8) + '…' : 'New'}</div>
                <div>Format: {outputFormat}</div>
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">AI capabilities</div>
              <div className="flex flex-col gap-1">
                {[
                  '📊 Historical analysis (1900–present)',
                  '🔮 Disaster prediction & risk scores',
                  '🆘 SOS triage and dispatch',
                  '📋 SITREP generation',
                  '🏛 Government policy briefs',
                  '🔍 Similar event matching',
                  '📈 Recovery timeline projection',
                  '🌍 Country vulnerability assessment',
                ].map(cap => (
                  <div key={cap} className="text-xs text-slate-500">{cap}</div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
