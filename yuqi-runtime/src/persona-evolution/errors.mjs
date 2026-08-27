export class PersonaEvolutionError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class PersonaValidationError extends PersonaEvolutionError {}

export class PersonaNotFoundError extends PersonaEvolutionError {}

export class PersonaDuplicateEntityError extends PersonaEvolutionError {}

export class PersonaRevisionConflictError extends PersonaEvolutionError {}

export class PersonaDataCorruptionError extends PersonaEvolutionError {}
