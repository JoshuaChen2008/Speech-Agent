## ADDED Requirements

### Requirement: Command-scoped model configuration settlement
The main-owned Agent 模型接入层 SHALL reconcile an uncertain write only for the credential operation that prepared a credential-vault token. A rejected non-credential configuration command MUST return a failure or revision-conflict result, preserve the authoritative configuration and revision, and MUST NOT be inferred as successful from an absent credential.

#### Scenario: Rejected connection update on an uncredentialed profile
- **WHEN** a user submits an invalid connection update for a profile whose credential is absent and storage rejects the command
- **THEN** the settings journey receives a failure result, the profile and configuration revision remain unchanged, and the entered values remain available for correction

#### Scenario: Credential operation with a lost storage reply
- **WHEN** a credential-setting command prepares a vault token, storage commits the matching credential state, and the reply is lost
- **THEN** the runtime reconciles the committed state, returns success with the committed revision, and leaves the credential available for later binding

#### Scenario: Rejected credential operation
- **WHEN** a credential-setting or credential-clearing command prepares a vault token and storage rejects the command
- **THEN** the runtime rolls back the prepared vault state and returns the existing configuration failure without changing the authoritative profile

#### Scenario: Stale configuration command
- **WHEN** any configuration command carries an older expected revision
- **THEN** the runtime returns the existing revision-conflict error before preparing or committing credential state
