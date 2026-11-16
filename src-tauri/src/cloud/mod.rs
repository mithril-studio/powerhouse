//! boxd access shared by VM image builds, chat VMs and Settings → Cloud → Machines:
//! the CLI transport, Keychain secrets, VM git helpers. See docs/vm-chats-plan.md.
pub mod machines;
pub mod secrets;
pub mod transport;
pub mod workspace;
