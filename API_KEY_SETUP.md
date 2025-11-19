# Claude AI API Key Setup

## Step 1: Get Your API Key

1. Visit https://console.anthropic.com/
2. Sign up or log in
3. Go to API Keys section
4. Click "Create Key"
5. Copy your API key (starts with `sk-ant-...`)

## Step 2: Add to OSC Backend

You have two options:

### Option A: Using MCP Tool (if available)
```javascript
// Use the MCP tool to create a secret
mcp__osc__create-service-secret({
  serviceId: "videoconfbackend",
  secretName: "ANTHROPIC_API_KEY",
  value: "your-api-key-here"
});
```

### Option B: Using OSC CLI
```bash
npx @osaas/cli@latest secret create videoconfbackend ANTHROPIC_API_KEY your-api-key-here
```

## Step 3: Restart the Backend

The backend will automatically pick up the new secret and enable Claude AI analysis.

## Testing the Feature

1. Open your video conference app
2. Click the robot (🤖) button in the bottom right
3. Click "📸 Analyze Meeting Screenshot"
4. Claude AI will analyze your meeting and respond!

## Pricing Note

Claude API usage is billed by Anthropic based on tokens used. The current implementation uses Claude 3.5 Sonnet with vision capabilities. Check https://www.anthropic.com/pricing for current rates.
