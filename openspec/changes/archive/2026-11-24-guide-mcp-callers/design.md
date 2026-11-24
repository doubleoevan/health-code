# Design

## The agent supplies the current repository

Clients start the server from the home directory, so its folder says nothing about the checkout. The coding agent knows the checkout. The tool descriptions ask it to pass the `origin` address. A call without a repository returns the command to find it.

## Check visibility before spending

One GitHub request runs before the sandbox starts. A missing or private repository stops there. It stops when the caller cancels and looks again without a token that GitHub rejects. A rate limit or network failure continues to the public clone, which reports the same cause.

## Failure messages

One function turns each inspection error into a cause and a next step. The code stays at the end for bug reports. Unknown errors keep their text private. Reading an inspection that is still running says to poll it. `health-code check` uses the same messages. Its repository check stays with the clone.
