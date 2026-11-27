# Spec Delta

## ADDED Requirements

### Requirement: Skip feature work when the caller allows no feature matches

When a caller sets the feature match limit to zero, the engine SHALL send no Code Feature Match request, run no Feature adoption and reserve no Feature adoption cost. It SHALL still request the release summary and run the repair.

#### Scenario: Limit of zero

- **WHEN** an Inspection runs with a feature match limit of zero and an Upgrade's tests fail
- **THEN** the model usage lists the release summary and the repair only, and the Upgrade has no Code Feature Match

#### Scenario: Budget

- **WHEN** an Inspection with a feature match limit of zero is admitted
- **THEN** its reserved upper bound includes no Feature adoption attempt

#### Scenario: Default limit

- **WHEN** a caller sets no feature match limit
- **THEN** matching and Feature adoption run as before
