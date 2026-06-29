param(
  [string]$BaseUrl = "https://mtman-machine-rotator.fly.dev/mountainview/api",
  [string]$Password = "mountainview-dev",
  [string]$TenantId = "94371378",
  [string]$Username = "mtman1987",
  [string]$Channel = "mtman1987",
  [string]$VisualContext = "watching twitch.tv/mamafeisty stream",
  [string[]]$Phrases = @(
    "hey Athena what do you remember about my stream today",
    "shoutout mamafeisty",
    "be right back",
    "back from break",
    "generate an image of Athena standing in my room",
    "send a message to mamafeisty that says hello from my glasses",
    "add a calendar event for Friday at 8 pm mod meeting",
    "request the song never gonna give you up in hear me out",
    "who is live in chat tag",
    "read what I see on the screen",
    "tag player professor evie"
  )
)

$loginBody = @{ email = "owner@spacemountain.live"; password = $Password } | ConvertTo-Json
$session = Invoke-RestMethod -Uri "$BaseUrl/login" -Method Post -ContentType "application/json" -Body $loginBody -TimeoutSec 20
$headers = @{ Authorization = "Bearer $($session.token)" }

$rows = foreach ($phrase in $Phrases) {
  $body = @{
    dryRun = $true
    transcript = $phrase
    context = @{
      destination = "ai"
      voiceMode = "reply"
      tenantId = $TenantId
      username = $Username
      channel = $Channel
      visualContext = $VisualContext
      source = "voice-router-test"
    }
  } | ConvertTo-Json -Depth 8

  try {
    $result = Invoke-RestMethod -Uri "$BaseUrl/voice/route" -Headers $headers -Method Post -ContentType "application/json" -Body $body -TimeoutSec 30
    [pscustomobject]@{
      phrase = $phrase
      mode = $result.decision.mode
      command = $result.decision.commandId
      app = $result.decision.appId
      confidence = $result.decision.confidence
      reason = $result.decision.reason
    }
  } catch {
    [pscustomobject]@{
      phrase = $phrase
      mode = "ERROR"
      command = ""
      app = ""
      confidence = ""
      reason = $_.Exception.Message
    }
  }
}

$rows | Format-Table -AutoSize -Wrap
