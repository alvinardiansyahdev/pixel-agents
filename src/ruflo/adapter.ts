/**
 * Ruflo Adapter - MCP integration for Ruflo agent management
 * 
 * Replaces Claude Code JSONL transcript polling with Ruflo MCP tools.
 * Handles: agent spawning, status polling, memory events, hive-mind communication.
 */

import * as vscode from 'vscode';

import { 
  AgentModel, 
  AgentStatus, 
  Bubble, 
  BubbleType,
  CouncilSession,
  RufloAgent,
  RufloMessage,
} from './types.js';

// Poll interval for agent status (ms)
const STATUS_POLL_INTERVAL = 2000;

// Bubble auto-fade duration (ms)
const BUBBLE_FADE_DURATION = 5000;

// MCP tool names (Ruflo)
const RUFLO_TOOLS = {
  AGENT_SPAWN: 'agent_spawn',
  AGENT_EXECUTE: 'agent_execute',
  AGENT_STATUS: 'agent_status',
  AGENT_TERMINATE: 'agent_terminate',
  AGENT_LIST: 'agent_list',
  MEMORY_STORE: 'memory_store',
  MEMORY_SEARCH: 'memory_search',
  HIVE_BROADCAST: 'hive_mind_broadcast',
  HIVE_CONSENSUS: 'hive_mind_consensus',
} as const;

interface RufloAdapterConfig {
  mcpServerName?: string;
  pollInterval?: number;
  bubbleFadeDuration?: number;
}

export class RufloAdapter {
  private agents: Map<string, RufloAgent> = new Map();
  private bubbles: Map<string, Bubble[]> = new Map();
  private statusTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private pollInterval: number;
  private bubbleFadeInterval: number;
  private webview: vscode.Webview | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private config: RufloAdapterConfig = {},
  ) {
    this.pollInterval = config.pollInterval ?? STATUS_POLL_INTERVAL;
    this.bubbleFadeInterval = config.bubbleFadeDuration ?? BUBBLE_FADE_DURATION;
  }

  /** Get extension context */
  getExtensionContext(): vscode.ExtensionContext {
    return this.context;
  }

  /** Get adapter config */
  getConfig(): RufloAdapterConfig {
    return this.config;
  }

  /** Set webview reference for messaging */
  setWebview(webview: vscode.Webview | undefined): void {
    this.webview = webview;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // AGENT SPAWNING
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Spawn a new agent via Ruflo MCP
   */
  async spawnAgent(params: {
    agentType: string;
    model?: AgentModel;
    domain?: string;
    task?: string;
    name?: string;
  }): Promise<RufloAgent | null> {
    try {
      // Call MCP tool via VS Code command (MCP bridge should be registered)
      const result = await vscode.commands.executeCommand<RufloMessage>(
        `ruflo.${RUFLO_TOOLS.AGENT_SPAWN}`,
        {
          agentType: params.agentType,
          model: params.model ?? 'sonnet',
          domain: params.domain ?? 'default',
          task: params.task ?? `Agent task for ${params.name ?? 'new agent'}`,
        }
      );

      if (result && result.agentId) {
        const agent: RufloAgent = {
          id: result.agentId,
          name: params.name ?? `Agent-${result.agentId}`,
          agentType: params.agentType,
          model: params.model ?? 'sonnet',
          domain: params.domain ?? 'default',
          status: 'starting',
          task: params.task,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          isActive: true,
          tileCol: 1,
          tileRow: 1,
        };

        this.agents.set(agent.id, agent);
        this.startStatusPolling(agent.id);
        
        // Notify webview
        this.webview?.postMessage({
          type: 'rufloAgentCreated',
          id: agent.id,
          name: agent.name,
          agentType: agent.agentType,
          model: agent.model,
          domain: agent.domain,
        });

        return agent;
      }

      return null;
    } catch (error) {
      console.error('[Ruflo Adapter] Failed to spawn agent:', error);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // AGENT STATUS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Start polling agent status
   */
  private startStatusPolling(agentId: string): void {
    if (this.statusTimers.has(agentId)) return;

    const timer = setInterval(async () => {
      await this.pollAgentStatus(agentId);
    }, this.pollInterval);

    this.statusTimers.set(agentId, timer);
  }

  /**
   * Poll agent status from Ruflo
   */
  private async pollAgentStatus(agentId: string): Promise<void> {
    try {
      const result = await vscode.commands.executeCommand<RufloMessage>(
        `ruflo.${RUFLO_TOOLS.AGENT_STATUS}`,
        { agentId }
      );

      if (result) {
        const agent = this.agents.get(agentId);
        if (!agent) return;

        const newStatus = (result.status as AgentStatus) ?? agent.status;
        
        // Only send update if status changed
        if (newStatus !== agent.status) {
          agent.status = newStatus;
          agent.lastActivityAt = Date.now();

          this.webview?.postMessage({
            type: 'agentStatus',
            id: agentId,
            status: mapStatusToLegacy(newStatus),
          });
        }

        // Check if agent is terminated
        if (result.status === 'terminated') {
          this.removeAgent(agentId);
        }
      }
    } catch (error) {
      console.error('[Ruflo Adapter] Failed to poll status:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // AGENT TERMINATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Terminate an agent
   */
  async terminateAgent(agentId: string): Promise<boolean> {
    try {
      const result = await vscode.commands.executeCommand<RufloMessage>(
        `ruflo.${RUFLO_TOOLS.AGENT_TERMINATE}`,
        { agentId, force: false }
      );

      if (result) {
        this.removeAgent(agentId);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[Ruflo Adapter] Failed to terminate agent:', error);
      return false;
    }
  }

  /**
   * Remove agent from tracking
   */
  private removeAgent(agentId: string): void {
    // Stop polling
    const timer = this.statusTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.statusTimers.delete(agentId);
    }

    // Remove bubbles
    this.bubbles.delete(agentId);

    // Update agent state
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = 'terminated';
      agent.isActive = false;
    }

    // Notify webview
    this.webview?.postMessage({
      type: 'agentClosed',
      id: agentId,
    });

    this.agents.delete(agentId);
  }

  // ��══════════════════════════════════════════════════════════════════════════════
  // BUBBLES & MESSAGING
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Show bubble for agent
   */
  showBubble(agentId: string, type: BubbleType, message: string, targetAgentId?: string): void {
    const bubble: Bubble = {
      id: `bubble-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      message: message.slice(0, 200), // Max 200 chars
      sourceAgentId: agentId,
      targetAgentId,
      timestamp: Date.now(),
      visible: true,
      fadeTimer: 0,
    };

    const agentBubbles = this.bubbles.get(agentId) ?? [];
    agentBubbles.push(bubble);
    this.bubbles.set(agentId, agentBubbles);

    // Auto-fade after duration
    setTimeout(() => {
      bubble.visible = false;
      this.webview?.postMessage({
        type: 'bubbleHide',
        agentId,
        bubbleId: bubble.id,
      });
    }, this.bubbleFadeInterval);

    // Notify webview
    this.webview?.postMessage({
      type: 'bubbleShow',
      agentId,
      bubbleId: bubble.id,
      bubbleType: bubble.type,
      message: bubble.message,
      targetAgentId,
    });
  }

  /**
   * Handle agent execution (show bubble when tool runs)
   */
  async onAgentExecute(agentId: string, prompt: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Show thinking bubble
    this.showBubble(agentId, 'thinking', prompt);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HIVE-MIND / COUNCIL
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Broadcast message to all agents
   */
  async broadcast(fromAgentId: string, message: string): Promise<void> {
    try {
      await vscode.commands.executeCommand<RufloMessage>(
        `ruflo.${RUFLO_TOOLS.HIVE_BROADCAST}`,
        {
          fromId: fromAgentId,
          message,
          priority: 'normal',
        }
      );

      // Show broadcast bubble on all agents
      for (const [agentId] of this.agents) {
        if (agentId !== fromAgentId) {
          this.showBubble(agentId, 'broadcast', message, fromAgentId);
        }
      }
    } catch (error) {
      console.error('[Ruflo Adapter] Failed to broadcast:', error);
    }
  }

  /**
   * Start council/consensus meeting
   */
  async startCouncil(agentIds: string[], type: 'consensus' | 'broadcast'): Promise<CouncilSession | null> {
    if (agentIds.length < 2) return null;

    const sessionId = `council-${Date.now()}`;
    const session: CouncilSession = {
      id: sessionId,
      type,
      participants: agentIds,
      votes: new Map(),
      status: 'proposing',
    };

    // Animate all agents walking to meeting table
    this.webview?.postMessage({
      type: 'councilStart',
      sessionId,
      participants: agentIds,
    });

    // Show bubble on each participant
    for (const agentId of agentIds) {
      this.showBubble(agentId, 'council', `${type} meeting - ${agentIds.length} participants`);
    }

    return session;
  }

  /**
   * Update council vote
   */
  updateCouncilVote(sessionId: string, agentId: string, vote: 'accept' | 'reject'): void {
    this.webview?.postMessage({
      type: 'councilVote',
      sessionId,
      agentId,
      vote,
    });
  }

  /**
   * End council session
   */
  endCouncil(sessionId: string, result: 'accepted' | 'rejected'): void {
    this.webview?.postMessage({
      type: 'councilEnd',
      sessionId,
      result,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get all tracked agents
   */
  getAgents(): RufloAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agent by ID
   */
  getAgent(agentId: string): RufloAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get bubbles for agent
   */
  getBubbles(agentId: string): Bubble[] {
    return this.bubbles.get(agentId) ?? [];
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    // Stop all polling timers
    for (const [, timer] of this.statusTimers) {
      clearInterval(timer);
    }
    this.statusTimers.clear();
    this.agents.clear();
    this.bubbles.clear();
  }
}

/**
 * Map Ruflo status to legacy pixel-agents status for webview compatibility
 */
function mapStatusToLegacy(status: AgentStatus): string {
  const map: Record<AgentStatus, string> = {
    idle: 'idle',
    starting: 'active',
    walking: 'walk',
    typing: 'active',
    reading: 'active',
    thinking: 'active',
    waiting: 'waiting',
    error: 'waiting',
    terminated: 'idle',
  };
  return map[status] ?? 'idle';
}