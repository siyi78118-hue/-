# Persona Evolution Storage examples

This directory contains synthetic development fixtures for the experimental
Persona Evolution Storage v0.1 module.

- The file-backed repository is not canonical storage and must not replace the
  existing application authorities.
- Every JSON document here is synthetic and safe for public source control.
- Never copy real user conversations, identity data, credentials, or local
  database contents into these examples.
- A future `SQLiteRepository` may replace the file backend without changing the
  `PersonaEvolutionRepository` contract.

Real local experiment data belongs under `yuqi-runtime/local_data/persona/`,
which is excluded from Git.
