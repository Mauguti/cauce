import React, { useState } from 'react';
import { Terminal, Filter, Download, Search } from 'lucide-react';

interface LogEntry {
  id: string;
  timestamp: string;
  agent: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  message: string;
  cost?: string;
}

interface TraceabilityLogsProps {
  logs: LogEntry[];
  filterOptions?: string[];
  agentColors?: Record<string, string>;
}

const DEFAULT_LEVEL_COLORS: Record<string, string> = {
  INFO: 'text-blue-400',
  WARN: 'text-yellow-400',
  ERROR: 'text-red-500',
  SUCCESS: 'text-green-400',
};

const TraceabilityLogs: React.FC<TraceabilityLogsProps> = ({
  logs,
  filterOptions = ['All'],
  agentColors = {},
}) => {
  const [filter, setFilter] = useState<string>('All');
  const [searchTerm, setSearchTerm] = useState('');

  const filteredLogs = logs.filter((log) => {
    const matchesAgent = filter === 'All' || log.agent === filter;
    const matchesSearch = log.message.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesAgent && matchesSearch;
  });

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col bg-[#0F172A] rounded-xl overflow-hidden border border-gray-700 shadow-2xl">
      {/* Toolbar */}
      <div className="bg-[#1E293B] border-b border-gray-700 p-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-gray-300 font-mono text-sm">
            <Terminal size={16} />
            <span className="font-bold">LIVE_TERMINAL_V2</span>
          </div>

          <div className="flex bg-[#0F172A] rounded p-1 border border-gray-700">
            {filterOptions.map((agent) => (
              <button
                key={agent}
                onClick={() => setFilter(agent)}
                className={`px-3 py-1 rounded text-xs font-mono transition-colors ${
                  filter === agent ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                {agent}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Grep logs..."
              className="bg-[#0F172A] border border-gray-700 rounded pl-9 pr-4 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 font-mono w-48"
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <button className="text-gray-400 hover:text-white transition-colors">
            <Download size={16} />
          </button>
        </div>
      </div>

      {/* Logs */}
      <div className="flex-1 overflow-y-auto p-4 font-mono text-xs md:text-sm space-y-1 bg-[#0F172A]">
        {filteredLogs.map((log) => (
          <div key={log.id} className="flex gap-4 hover:bg-[#1E293B] p-1 rounded transition-colors group">
            <span className="text-gray-500 w-20 shrink-0 select-none">[{log.timestamp}]</span>
            <span className={`w-20 font-bold shrink-0 ${agentColors[log.agent] || 'text-gray-400'}`}>
              {log.agent.toUpperCase()}
            </span>
            <span className={`w-20 font-bold shrink-0 ${DEFAULT_LEVEL_COLORS[log.level] || 'text-gray-400'}`}>
              {log.level}
            </span>
            <span className="text-gray-300 flex-1 break-all">{log.message}</span>
            <span className="text-gray-600 shrink-0 w-16 text-right group-hover:text-gray-400">{log.cost}</span>
          </div>
        ))}
        <div className="animate-pulse text-gray-500 mt-2">_</div>
      </div>

      {/* Footer */}
      <div className="bg-[#1E293B] border-t border-gray-700 p-2 px-4 flex justify-between items-center text-[10px] text-gray-500 font-mono">
        <span>Status: LISTENING</span>
        <span>{filteredLogs.length} events filtered</span>
      </div>
    </div>
  );
};

export default TraceabilityLogs;
