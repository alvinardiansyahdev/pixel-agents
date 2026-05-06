/**
 * Ruflo Agent Types - Type definitions for Ruflo MCP integration
 */

export type AgentModel = 'haiku' | 'sonnet' | 'opus';

export type AgentStatus = 
  | 'idle' 
  | 'starting' 
  | 'walking' 
  | 'typing' 
  | 'reading' 
  | 'thinking' 
  | 'waiting' 
  | 'error'
  | 'terminated';

export type BubbleType = 
  | 'thinking' 
  | 'question' 
  | 'answer' 
  | 'error' 
  | 'broadcast' 
  | 'council';

export interface RufloAgent {
  id: string;
  name: string;
  agentType: string;
  model: AgentModel;
  domain: string;
  status: AgentStatus;
  task?: string;
  createdAt: number;
  lastActivityAt: number;
  isActive: boolean;
  parentAgentId?: string;
  // Position in office
  deskId?: string;
  tileCol: number;
  tileRow: number;
}

export interface Bubble {
  id: string;
  type: BubbleType;
  message: string;
  sourceAgentId: string;
  targetAgentId?: string;
  timestamp: number;
  visible: boolean;
  fadeTimer: number;
}

export interface CouncilSession {
  id: string;
  type: 'consensus' | 'broadcast' | 'handoff';
  participants: string[];
  votes: Map<string, 'accept' | 'reject'>;
  status: 'proposing' | 'voting' | 'decided';
  result?: 'accepted' | 'rejected';
}

export interface RufloMessage {
  type: string;
  agentId?: string;
  [key: string]: unknown;
}

// Model color mapping - matches SPEC
export const MODEL_COLORS: Record<AgentModel, number> = {
  haiku: 0x22C55E,   // Green
  sonnet: 0x3B82F6,  // Blue
  opus: 0x8B5CF6,    // Purple
};

// Status animation mapping
export const STATUS_ANIMATION: Record<AgentStatus, string> = {
  idle: 'idle',
  starting: 'typing',
  walking: 'walk',
  typing: 'typing',
  reading: 'reading',
  thinking: 'thinking',
  waiting: 'waiting',
  error: 'error',
  terminated: 'walk',
};