# PorkTraceability — πλήρες μοντέλο εφοδιαστικής αλυσίδας

**Έκδοση v2.0.0.** Το απλοποιημένο μοντέλο (μόνο εστιατόριο και πελάτης, contract `PorkTrace`) είναι η έκδοση **v1.0.0**, στο branch `simplified`.

Υλοποίηση σε Solidity της §6 του tab *Full supply chain* του εγγράφου *Blockchain Traceability Architecture for Pork in Food Service*.
Η αλυσίδα είναι σφαγείο → τεμαχιστήριο → μεταποιητής → ψυκτική μεταφορά → σουβλατζίδικο → καταναλωτής, σε ιδιωτικό Hyperledger Besu (QBFT, gas price 0).

## Δομή

| Αρχείο | Module (§3.3) |
|---|---|
| `contracts/PorkTypes.sol` | enums και structs (Πίνακας 3) |
| `contracts/modules/AccessRegistry.sol` | Access control: οργανισμοί, συσκευές, ρόλοι (OpenZeppelin AccessControl) |
| `contracts/modules/BatchStorage.sol` | κοινή κατάσταση και read functions (`getProvenance`, `originOf`, `isRecalled`, …) |
| `contracts/modules/TraceabilityRegistry.sol` | Traceability registry: σφάγια, επιθεώρηση, `transform`, `ship`/`receiveBatch`, ψήσιμο, πωλήσεις |
| `contracts/modules/ColdChainMonitor.sol` | Cold-chain monitor: όρια θερμοκρασίας, αναφορές αισθητήρων, καραντίνα |
| `contracts/modules/RecallManager.sol` | Recall manager: ανάκληση με διάδοση στους απογόνους |
| `contracts/PorkTraceability.sol` | το deployable contract, με τα default όρια του Πίνακα 7 |

Οι συναρτήσεις, οι έλεγχοί τους και τα events είναι αυτά του Πίνακα 6.

## Αναλλοίωτες ιδιότητες (§6.3), καθεμία με test

1. Μόνο ο τρέχων κάτοχος (custodian) μπορεί να μεταποιήσει ή να αποστείλει ένα batch.
2. Ένα σφάγιο δεν βγαίνει από το `PENDING_INSPECTION` χωρίς εγγραφή κτηνιάτρου, που πρέπει να είναι διαφορετικός λογαριασμός από το σφαγείο που το δημιούργησε.
3. Το κρέας στα outputs μιας μεταποίησης δεν ξεπερνά το κρέας που καταναλώθηκε από τα inputs.
4. Οι μερίδες που πωλούνται από ένα serving lot δεν ξεπερνούν αυτές που παράχθηκαν.
5. Batch σε καραντίνα ή ανάκληση, ή με ανακληθέντα πρόγονο, δεν μεταποιείται, δεν αποστέλλεται και δεν πωλείται.
6. Batch μετά την ημερομηνία λήξης (use-by) δεν μεταποιείται, δεν αποστέλλεται και δεν πωλείται.
7. Παράδοση με θερμοκρασία παραλαβής πάνω από το όριο δεν μπορεί να γίνει αποδεκτή.
8. Μετά τη σφαγή, η προέλευση υπολογίζεται από τα inputs και δεν τη γράφει κανείς.
9. Κάθε αλλαγή κατάστασης εκπέμπει event, οπότε το off-chain read model ξαναχτίζεται μόνο από το ledger.

Τα όρια ανά συναλλαγή (§6.4) είναι έως 16 inputs και 64 outputs ανά μεταποίηση, και έως 64 batches ανά αναφορά θερμοκρασίας.

## Εντολές

```bash
npm install --legacy-peer-deps
npm test            # 31 tests
BESU_RPC_URL=http://<node>:8545 DEPLOYER_KEY=0x... npm run deploy
```

Ο compiler (solc 0.8.24, via-IR, EVM `london`) φορτώνεται από το πακέτο `solc` του npm. Το runtime bytecode είναι περίπου 17 KB, κάτω από το όριο των 24 KB.
