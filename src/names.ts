import { randomBytes } from "node:crypto";
import type { Registry } from "./types.js";

const NAME_POOL: readonly string[] = [
  "achilles", "adonis", "aegis", "aeneas", "aeolus",
  "agamemnon", "ajax", "alcmene", "amphitrite", "andromeda",
  "antigone", "aphrodite", "apollo", "arachne", "ares",
  "ariadne", "artemis", "asclepius", "asteria", "astraea",
  "atalanta", "athena", "atlas", "aurora", "bacchus",
  "bellerophon", "boreas", "cadmus", "calliope", "calypso",
  "cassandra", "castor", "ceres", "charon", "chimera",
  "chronos", "circe", "clio", "clytemnestra", "cronus",
  "cybele", "daedalus", "daphne", "deimos", "demeter",
  "diana", "diomedes", "dionysus", "echo", "electra",
  "eos", "epimetheus", "erato", "erebus", "eris",
  "eros", "euclid", "euphrosyne", "europa", "eurydice",
  "euterpe", "flora", "fortuna", "gaia", "galatea",
  "ganymede", "hades", "harmonia", "hebe", "hecate",
  "hector", "helen", "helios", "hephaestus", "hera",
  "heracles", "hermes", "hestia", "hippolyta", "hygieia",
  "hyperion", "hypnos", "icarus", "io", "iris",
  "isis", "janus", "jason", "juno", "jupiter",
  "ladon", "leda", "leto", "luna", "maia",
  "mars", "medea", "medusa", "melpomene", "mentor",
  "mercury", "metis", "midas", "minerva", "minos",
  "mnemosyne", "morpheus", "muse", "narcissus", "nemesis",
  "neptune", "nereus", "nike", "nyx", "oceanus",
  "odysseus", "olympus", "ophelia", "oracle", "orion",
  "orpheus", "pallas", "pan", "pandora", "paris",
  "pegasus", "penelope", "persephone", "perseus", "phaethon",
  "philoctetes", "phobos", "phoenix", "pluto", "pollux",
  "polyhymnia", "poseidon", "priam", "prometheus", "proteus",
  "psyche", "rhea", "saturn", "selene", "sibyl",
  "siren", "sisyphus", "sol", "sphinx", "styx",
  "tantalus", "terpsichore", "thalia", "thanatos", "theia",
  "themis", "theseus", "thetis", "titan", "triton",
  "typhon", "urania", "uranus", "venus", "vesta",
  "vulcan", "zephyr", "zeus", "aether", "aletheia",
  "antaeus", "arete", "argos", "arion", "ate",
  "briareus", "ceto", "coeus", "crius", "dione",
  "enyo", "epona", "erinys", "fates", "furor",
  "griffin", "halcyon", "hecuba", "hemera", "hesperus",
  "iapetus", "idris", "ixion", "kore", "kratos",
  "lethe", "lycaon", "manto", "megara", "moira",
] as const;

export function getNamePool(): readonly string[] {
  return NAME_POOL;
}

export function generateHexSuffix(): string {
  return randomBytes(2).toString("hex");
}

export function allocateName(
  registry: Registry,
): { name: string; fullId: string } {
  const usedNames = new Set<string>();
  for (const entry of Object.values(registry.instances)) {
    usedNames.add(entry.name);
  }

  const available = NAME_POOL.filter((n) => !usedNames.has(n));
  if (available.length === 0) {
    throw new Error(
      "Name pool exhausted — all names are in use",
    );
  }

  const idx = Math.floor(Math.random() * available.length);
  const name = available[idx];
  const suffix = generateHexSuffix();
  const fullId = `${name}-${suffix}`;

  if (registry.instances[fullId]) {
    return allocateName(registry);
  }

  return { name, fullId };
}

export function resolveShortName(
  registry: Registry,
  shortName: string,
): string {
  const matches: string[] = [];
  for (const [fullId, entry] of Object.entries(
    registry.instances,
  )) {
    if (entry.name === shortName || fullId === shortName) {
      matches.push(fullId);
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `No instance found with name "${shortName}"`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous name "${shortName}" — matches: ${matches.join(", ")}`,
    );
  }

  return matches[0];
}
