---
name: intervu
description: Drive a collaborative human review of an HTML artifact you generated - open a review, long-poll for the human's annotated feedback, edit the file so the browser live-reloads, and reply while you keep listening. Use when you have produced an HTML artifact and want a human to review it before you continue.
---

# intervu

intervu turns an HTML artifact you generated into a collaborative browser review surface.
You open a review for the file, the human annotates the rendered page in their browser, and you long-poll for that feedback and live-edit the file in response.
Every command prints content-first TOON with a `help` line telling you the next step.

## When to reach for intervu

Reach for intervu when you have produced an HTML artifact - a page, a prototype, a report - and you want a human to review it before you move on.
Open a review instead of guessing whether the result is right, or asking the human to describe what they see in prose.

## The loop

1. **Open or resume a Session.**
   Run `intervu <file>` (an alias for `intervu open <file>`) on the artifact's path.
   This starts the review daemon if needed, opens a Session for the file, and pops a browser tab showing your artifact inside intervu's chrome.
   Re-running `open` on the same path resumes the same Session - the key is derived from the path, so it is stable across your edits.

2. **Poll for Feedback.**
   Run `intervu poll <file>` and block.
   The poll holds open silently until the human sends, then returns their queued Feedback as TOON.
   While the poll is open the human sees your presence as `listening`.

3. **Read the Feedback and edit the artifact.**
   Apply the changes to the file on disk.
   The browser live-reloads on save, so the human sees your edit immediately.

4. **Reply and keep listening.**
   Run `intervu poll <file> --agent-reply "<what you changed>"`.
   The `--agent-reply` message is posted into the human's conversation panel before the poll waits again, so the thread reads as one conversation and the human knows what you did.

5. **End when you are done.**
   When the review is finished, run `intervu end <file>` to end the Session.
   The human can also end it from the browser; your current or next poll then returns `ended`.
   Ending is reversible - re-running `intervu <file>` reopens the path to a live review.

## Reading a Feedback

Each Feedback carries three things:

- **Annotations** - the markers the human attached to the page.
  Each has a CSS `selector`, the element `tag`, and the surrounding `text` (a `text` annotation also carries the exact `selectedText`).
- **The message** - the human's words for this submission.
- **The DOM snapshot** - the serialized live DOM the human actually annotated.
  The annotation selectors resolve against this snapshot, not against your on-disk source.
  For an interactive artifact the rendered DOM diverges from the file on disk, so read the snapshot to locate what each selector points at, then make the change in the source file.

## Poll discipline

The poll is built to be safe under interruption:

- It is safe to kill and re-run.
  Queued Feedback is never lost - a re-run drains whatever is waiting.
- A silent poll means it is listening, not that it failed or hung.
  Leave it blocked until the human sends.
- Pass `--timeout <seconds>` if you want the poll to return `timedOut` instead of waiting indefinitely, then re-run to keep listening.
