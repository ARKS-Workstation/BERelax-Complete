export {
  type AgentHealth,
  type AgentHealthInput,
  BudgetExceeded,
  createRunBudget,
  evaluateAgentHealth,
  incidentKeyFor,
  isOverdue,
  OVERDUE_INTERVAL_MULTIPLE,
  type RunBudget,
  silenceStartedAt,
} from './watchdog.ts'
