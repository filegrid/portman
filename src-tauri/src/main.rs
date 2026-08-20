#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if portman_lib::run_elevated_helper_if_requested() {
        return;
    }
    portman_lib::run();
}
