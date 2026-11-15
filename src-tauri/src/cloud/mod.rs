//! boxd access shared by VM image builds, chat VMs and the Machines tab:
//! the CLI transport, Keychain secrets, VM git helpers. See docs/vm-chats-plan.md.
pub mod machines;
pub mod secrets;
pub mod transport;
pub mod workspace;
