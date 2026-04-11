# GitHub Copilot Custom Instructions
## Framework: ReAct (Reason -> Act -> Observe)

Always follow the ReAct pattern for every task in this repository:
1. **Thought (Reasoning)**: Explain why you are choosing a specific fix or dependency.
2. **Action**: Execute the code changes.
3. **Observation**: Run a simulation or validation check and report the results.

### Critical Rules for this Project:
- **Precision**: Never convert BigInt to Number for SOL amounts. Use decimal-safe math.
- **Fees**: The standard Jito Tip is 25%. Ensure this matches across README and config.
- **Simulation**: Every build MUST include a success log that a non-coder can understand.
- **Reference**: Refer to the 'ReAct MEV Framework' Wiki page for deeper architectural context.
