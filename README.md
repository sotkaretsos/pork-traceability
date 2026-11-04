# PorkTraceability — πλήρες μοντέλο εφοδιαστικής αλυσίδας

**Έκδοση v2.0.0.** Το απλοποιημένο μοντέλο (μόνο εστιατόριο και πελάτης, contract `PorkTrace`) είναι η έκδοση **v1.0.0**, στο branch `simplified` και στο tag `v1.0.0`.

Υλοποίηση σε Solidity της §6 του εγγράφου *Blockchain Traceability Architecture for Pork in Food Service* (tab «Full supply chain»):
σφαγείο → τεμαχιστήριο → μεταποιητής → ψυκτική μεταφορά → σουβλατζίδικο → καταναλωτής, σε ιδιωτικό Hyperledger Besu (QBFT, gas price 0).

## Δομή

| Αρχείο | Module (§3.3) |
|---|---|
| `contracts/PorkTypes.sol` | enums & structs (Πίνακας 3) |
| `contracts/modules/AccessRegistry.sol` | Access control — οργανισμοί, συσκευές, ρόλοι (OpenZeppelin AccessControl) |
| `contracts/modules/BatchStorage.sol` | κοινή κατάσταση, read functions (`getProvenance`, `originOf`, `isRecalled`, …) |
| `contracts/modules/TraceabilityRegistry.sol` | Traceability registry — σφάγια, επιθεώρηση, transform, ship/receive, ψήσιμο, πωλήσεις |
| `contracts/modules/ColdChainMonitor.sol` | Cold-chain monitor — όρια θερμοκρασίας, αναφορές αισθητήρων, καραντίνα |
| `contracts/modules/RecallManager.sol` | Recall manager — ανάκληση με διάδοση στους απογόνους |
| `contracts/PorkTraceability.sol` | το deployable contract, με τα default όρια του Πίνακα 7 |

## Εντολές

```bash
npm install --legacy-peer-deps
npm test            # 31 tests, ένα για κάθε αναλλοίωτη ιδιότητα της §6.3 και τα σενάρια της §5
BESU_RPC_URL=http://<node>:8545 DEPLOYER_KEY=0x... npm run deploy
```

Ο compiler (solc 0.8.24, via-IR, EVM `london`) φορτώνεται από το πακέτο `solc` του npm. Runtime bytecode ≈ 17 KB (< 24 KB).

## Αποκλίσεις από τον Πίνακα 6

- `receive(...)` → **`receiveBatch(...)`**: το `receive` είναι δεσμευμένη λέξη στη Solidity.
- `transform(...)` παίρνει επιπλέον `storageType`, `useBy`, `docHash` (ο Πίνακας 5 τα ορίζει ως δεδομένα των σταδίων 4, 5 και 9). Το `units` είναι ένας πίνακας με μία τιμή ανά output.
- Τα ζώα (ενώτια) δεν γράφονται ξεχωριστά. Καλύπτονται από το `docHash` του εγγράφου διακίνησης.
- Νέα: `setCookingMinimum` (AUTHORITY, default 75 °C), `deactivateDevice` (ADMIN), `effectiveStatus`, `hasBreachInAncestry` και getters για επιθεώρηση, αποστολή, ψυχρή αλυσίδα, ψήσιμο και ανάκληση.

## Κανόνες που προστέθηκαν όπου το έγγραφο δεν ήταν ρητό

- Ο κτηνίατρος δεν μπορεί να επιθεωρήσει batch που δημιούργησε ο ίδιος λογαριασμός.
- Ληγμένο batch (`useBy` περασμένο) δεν μπορεί να μετασχηματιστεί, να αποσταλεί ή να πωληθεί. Το `useBy` ενός output δεν μπορεί να ξεπερνά το νωρίτερο `useBy` των inputs.
- Παραλαβή με `accepted = true` απορρίπτεται αν η θερμοκρασία παραλαβής ξεπερνά το όριο. Ο παραλήπτης πρέπει να απορρίψει την παράδοση.
- Θερμοκρασία ψησίματος κάτω από το ελάχιστο **καταγράφεται και επισημαίνεται** (`meetsMinimum = false`), αλλά δεν μπλοκάρει τις πωλήσεις.
- Η καραντίνα θυμάται την προηγούμενη κατάσταση. Η αποδέσμευση γυρίζει σε `IN_TRANSIT`, `ACTIVE` ή `PENDING_INSPECTION`.
- Όρια: `MAX_INPUTS = 16` ανά μετασχηματισμό (κρατά πεπερασμένο το `isRecalled`), `MAX_OUTPUTS = 64`, `MAX_BATCHES_PER_REPORT = 64`.
