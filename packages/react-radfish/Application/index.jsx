import { Toast } from "../alerts";
import { createContext, useEffect, useContext, useRef } from "react";
import { useOfflineStatus, useToasts, dispatchToast } from "../hooks";
import { OfflineStorageWrapper } from "../OfflineStorage";

const ApplicationContext = createContext();

function ApplicationComponent(props) {
  const { toasts } = useToasts();
  const { isOffline } = useOfflineStatus();
  const prevIsOffline = useRef(null);

  useEffect(() => {
    if (prevIsOffline.current === null) {
      prevIsOffline.current = isOffline;
    } else if (prevIsOffline.current && !isOffline) {
      dispatchToast({ message: "Application is online", status: "info", duration: 3000 });
    }
    prevIsOffline.current = isOffline;
  }, [isOffline]);

  return (
    <div className="radfish__application">
      <div style={{ position: "sticky", width: "100%", top: 0, zIndex: 399 }}>
        {isOffline && <Toast toast={{ message: "Application is offline", status: "warning" }} />}
        {toasts.map((toast, i) => (
          <Toast toast={toast} key={i} />
        ))}
      </div>
      {props.children}
    </div>
  );
}

export function Application({ application = null, children }) {
  if (application?.storage) {
    return (
      <ApplicationContext.Provider value={application}>
        <OfflineStorageWrapper>
          <ApplicationComponent>{children}</ApplicationComponent>
        </OfflineStorageWrapper>
      </ApplicationContext.Provider>
    );
  } else {
    return (
      <ApplicationContext.Provider value={application}>
        <ApplicationComponent>{children}</ApplicationComponent>
      </ApplicationContext.Provider>
    );
  }
}

export const useApplication = () => {
  const application = useContext(ApplicationContext);
  if (!application) {
    throw new Error("useApplication must be used within an Application component");
  }
  return application;
};

