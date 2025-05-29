“If you write TypeScript like this, somewhere a software architect just stubbed his toe in rage and doesn’t know why.”

Buckle up, dev — let’s roast this code like it’s a cold cup of Starbucks someone dared to microwave.

⸻

🔥 Roast Breakdown

1. async getApiResult<T> — More like getNullMaybeResult
	•	Name’s lying. The function says “get API result” but your default return path is null. That’s a getMaybeResultWithNullSadness, my dude.
	•	Returning null instead of throwing or Result/Either types? You’re forcing every caller to check if (!res) like it’s 2006.
	•	You promise a T, but you’re actually returning T | null. Type safety called, it wants its dignity back.

2. firstValueFrom abuse
	•	OK fine, you’re using firstValueFrom to convert observable to promise. That’s acceptable… but:

const apiResult = await firstValueFrom(apiRequest) as ServerResponse<T>;

This cast is suspect AF. What if apiRequest just gives you a plain object or a different shape entirely? You just YOLO’d past structural typing, hoping it all works out.

3. This logic:

if (apiResult.hasError || !apiResult.success)

What in the indecisive boolean hell is this?
	•	Pick a contract and stick with it. If hasError is true, success should be false. Or better yet, define an actual type-safe response union, like:

type ServerResponse<T> = 
  | { success: true; data: T }
  | { success: false; error: string }



4. this.showError(apiResult.message || errorMsg)
	•	apiResult.message — what if it’s undefined? Better to wrap that logic cleanly, or use optional chaining and default properly.
	•	Also, who the hell made the decision that this utility layer should be showing UI errors directly? Separation of concerns got kicked out like a drunk uncle at a wedding.

⸻

💀 Caller Method: someApiCalling()

5. Method name?

someApiCalling()

	•	That sounds like a bad translation in a bootleg programming book. At least name your method something like fetchApplicationStatus or retrieveStudentRecord.

6. This abomination:

let res = await this.utilSrv.getApiResult<string>(
  this.apiSrv.someApiCall(appNo, matricNo),
  "Unable to get desired result"
);

	•	Wrapping a service call like this just to catch error and return null is lazy abstraction. You could’ve just used a proper try/catch at the callsite and been more expressive.
	•	Also, you’re calling .someApiCall and passing that as an observable to .getApiResult, and hiding the fact it’s async behind the utility — your stack trace in production is going to be one line long and useless.

7. And the classic:

if (!res) return;
// do something with res

	•	This is how bugs get born. If res is falsy, silently returning does nothing. No logging, no telemetry, no retry — just a ghost of intent. 👻

⸻

🧽 Final Verdict: This ain’t Clean Code. It’s Febreze Code.

You’re trying to mask the stench of poor contracts and lazy error handling with a utility wrapper. But it only smells fresh until someone actually uses it.

⸻

🧠 What You Should Do Instead

Here’s a quick enterprise-level refactor using Result types and proper error contracts:

// result.ts
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// api-util.service.ts
async getApiResult<T>(apiRequest: Observable<unknown>): Promise<Result<T>> {
  try {
    const raw = await firstValueFrom(apiRequest);
    const result = raw as ServerResponse<T>;

    if (result.hasError || !result.success) {
      return { ok: false, error: result.message ?? 'Unknown API error' };
    }

    return { ok: true, value: result.data };
  } catch (e) {
    console.error(e);
    return { ok: false, error: 'Network error or bad response' };
  }
}

// usage
const response = await this.utilSrv.getApiResult<string>(
  this.apiSrv.someApiCall(appNo, matricNo)
);

if (!response.ok) {
  this.showError(response.error);
  return;
}

// Safe to use response.value here

That’s how you write code like a professional and not a stressed-out intern in a rush to make standup.

⸻

TL;DR:
This code tries to be helpful but ends up being a passive-aggressive middleman who lies about what’s going on and drops silent errors like your codebase is a minefield.

Refactor it. Give it types. Return Result<T> not nulls. And stop writing functions with names like a confused chatbot.

You asked for Roast x11. This was Roast x🔥∞.