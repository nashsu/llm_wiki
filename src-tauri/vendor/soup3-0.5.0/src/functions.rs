use ffi;
use glib;
use glib::translate::*;

#[doc(alias = "soup_header_g_string_append_param")]
pub fn header_g_string_append_param(header: &mut String, name: &str, value: &str) {
    unsafe {
        let hdr = glib::ffi::g_string_new_len(header.as_ptr() as *const _, header.len() as isize);
        ffi::soup_header_g_string_append_param(hdr, name.to_glib_none().0, value.to_glib_none().0);
        let s: glib::GString = from_glib_full(glib::ffi::g_string_free(hdr, glib::ffi::GFALSE));
        header.clone_from(&s.as_str().to_owned())
    }
}

#[doc(alias = "soup_header_g_string_append_param_quoted")]
pub fn header_g_string_append_param_quoted(header: &mut String, name: &str, value: &str) {
    unsafe {
        let hdr = glib::ffi::g_string_new_len(header.as_ptr() as *const _, header.len() as isize);
        ffi::soup_header_g_string_append_param_quoted(
            hdr,
            name.to_glib_none().0,
            value.to_glib_none().0,
        );
        let s: glib::GString = from_glib_full(glib::ffi::g_string_free(hdr, glib::ffi::GFALSE));
        header.clone_from(&s.as_str().to_owned())
    }
}

// #[doc(alias = "soup_cookies_free")]
// pub fn cookies_free(cookies: &[&Cookie]) {
//     assert_initialized_main_thread!();
//     unsafe {
//         let cookie_list: *mut glib::ffi::GSList = ToGlibContainerFromSlice::to_glib_none_from_slice(cookies).0;
//         ffi::soup_cookies_free(cookie_list);
//     }
// }

// #[doc(alias = "soup_cookies_to_cookie_header")]
// pub fn cookies_to_cookie_header(cookies: &[Cookie]) -> Option<glib::GString> {
//     assert_initialized_main_thread!();
//     unsafe {
//         let cookie_list: *mut glib::ffi::GSList = ToGlibContainerFromSlice::to_glib_none_from_slice(cookies).0;
//         from_glib_full(ffi::soup_cookies_to_cookie_header(cookie_list))
//     }

// }

// #[doc(alias = "soup_cookies_to_request")]
// pub fn cookies_to_request(cookies: &[&Cookie], msg: &Message) {
//     skip_assert_initialized!();
//     unsafe {
//         ffi::soup_cookies_to_request(cookies.to_glib_none().0, msg.to_glib_none().0);
//     }
// }

// #[doc(alias = "soup_cookies_to_response")]
// pub fn cookies_to_response(cookies: &[Cookie], msg: &Message) {
//     skip_assert_initialized!();
//     unsafe {
//         ffi::soup_cookies_to_response(cookies.to_glib_none().0, msg.to_glib_none().0);
//     }
// }
