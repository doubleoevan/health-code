# CI command test fixtures

`modelRequestSandboxInspection.ts` supplies recorded repository commands, release evidence and model replies for the unit tests.

`inspectionSettings.ts` supplies synthetic account settings, the folder of recorded projects and the recorded inspection path.

`publicProject.ts` serves a recorded project and its registry versions through the library's fake GitHub, at the commit the recorded sandbox reports.

`runCheck.ts` runs `health-code check` against a recorded project for the command tests and the target selection tests. It supplies the repository address and the CI settings, counts the sandboxes the check allocates, and can make the recorded upgrade fail its tests until an agent repairs it.

`fakeRepositoryApi.ts` serves pull requests that each move `widget` through the library's fake GitHub, and keeps the references, commits, statuses, comments and removed labels the dependency pull request steps write. A test sets the checks of a commit, an account's permission and the open pull request of a patch branch.
