use crate::{Logger, LoggerLogLevel};
use glib::object::IsA;
use glib::translate::*;
use glib::GStr;
use std::boxed::Box as Box_;

mod sealed {
    pub trait Sealed {}
    impl<T: glib::IsA<crate::Logger>> Sealed for T {}
}

pub trait LoggerExtManual: IsA<Logger> + sealed::Sealed + 'static {
    #[doc(alias = "soup_logger_set_printer")]
    fn set_printer<P: Fn(&Logger, LoggerLogLevel, char, &GStr) + Send + Sync + 'static>(
        &self,
        printer: P,
    ) {
        let printer_data: Box_<P> = Box_::new(printer);
        unsafe extern "C" fn printer_func<
            P: Fn(&Logger, LoggerLogLevel, char, &GStr) + Send + Sync + 'static,
        >(
            logger: *mut ffi::SoupLogger,
            level: ffi::SoupLoggerLogLevel,
            direction: libc::c_char,
            data: *const libc::c_char,
            user_data: glib::ffi::gpointer,
        ) {
            let logger = from_glib_borrow(logger);
            let direction: glib::Char = from_glib(direction);
            let data: &GStr = GStr::from_ptr(data);
            let callback: &P = &*(user_data as *mut _);
            (*callback)(&logger, from_glib(level), char::from(direction), data);
        }
        unsafe extern "C" fn destroy_func<
            P: Fn(&Logger, LoggerLogLevel, char, &GStr) + Send + Sync + 'static,
        >(
            data: glib::ffi::gpointer,
        ) {
            let _callback: Box_<P> = Box_::from_raw(data as *mut _);
        }
        unsafe {
            ffi::soup_logger_set_printer(
                self.as_ref().to_glib_none().0,
                Some(printer_func::<P> as _),
                Box_::into_raw(printer_data) as *mut _,
                Some(destroy_func::<P> as _),
            )
        }
    }
}

impl<O: IsA<Logger>> LoggerExtManual for O {}
